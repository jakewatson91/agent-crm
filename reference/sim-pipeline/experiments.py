"""
Experiments framework — every pipeline decision is a multi-arm experiment.

This module:
  1. Loads the pre-registered experiments from config/experiments.yaml
  2. Persists posteriors per experiment per arm in the CRM (table: experiments)
  3. Records outcomes (reward signal events) and updates posteriors
  4. Exposes Thompson-sampling allocation for live decisions

Usage as a library:
    from scripts.p2 import experiments
    arm = experiments.sample("alignment_cutoff")     # Thompson-sampled arm
    experiments.record("alignment_cutoff", arm, reward=1.0)

Usage as a CLI:
    python -m scripts.p2.experiments status         # show all experiments + posteriors
    python -m scripts.p2.experiments init           # initialize experiments table from yaml

Bandit math: Beta(α, β) per arm. α += reward, β += (1 - reward) for binary
outcomes. For cascading rewards (touch_dimensions), reward is summed and
treated as a single sample with that magnitude.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any

import yaml

from . import crm
from ._common import REPO_ROOT

EXPERIMENTS_YAML = REPO_ROOT / "config" / "experiments.yaml"


def load_experiments() -> list[dict]:
    if not EXPERIMENTS_YAML.exists():
        return []
    with EXPERIMENTS_YAML.open() as f:
        data = yaml.safe_load(f)
    return data.get("experiments", []) if data else []


def init_table(con) -> None:
    con.executescript("""
        CREATE TABLE IF NOT EXISTS experiments (
            experiment_id TEXT NOT NULL,
            arm           TEXT NOT NULL,
            segment       TEXT NOT NULL DEFAULT '_global',
            alpha         REAL NOT NULL DEFAULT 1.0,
            beta          REAL NOT NULL DEFAULT 1.0,
            n_samples     INTEGER NOT NULL DEFAULT 0,
            cumulative_reward REAL NOT NULL DEFAULT 0.0,
            status        TEXT NOT NULL DEFAULT 'active',
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (experiment_id, arm, segment)
        );
        CREATE INDEX IF NOT EXISTS idx_experiments_lookup
            ON experiments(experiment_id, segment, status);
    """)
    con.commit()


def init_from_yaml() -> None:
    """Seed the experiments table with one row per (experiment, arm) — flat arms only."""
    crm.init()
    with crm.connect() as con:
        init_table(con)
        for exp in load_experiments():
            arms = exp.get("arms", [])
            if isinstance(arms, list):
                for arm in arms:
                    con.execute(
                        "INSERT OR IGNORE INTO experiments(experiment_id, arm, segment) VALUES (?, ?, ?)",
                        (exp["id"], str(arm), "_global"),
                    )
            elif isinstance(arms, dict):
                # Per-segment or per-dimension arms
                for segment, arm_list in arms.items():
                    if isinstance(arm_list, list):
                        for arm in arm_list:
                            con.execute(
                                "INSERT OR IGNORE INTO experiments(experiment_id, arm, segment) VALUES (?, ?, ?)",
                                (exp["id"], str(arm), str(segment)),
                            )
            arms_per_seg = exp.get("arms_per_segment", {})
            for segment, arm_list in arms_per_seg.items():
                for arm in arm_list:
                    con.execute(
                        "INSERT OR IGNORE INTO experiments(experiment_id, arm, segment) VALUES (?, ?, ?)",
                        (exp["id"], str(arm), str(segment)),
                    )
        con.commit()


def sample(experiment_id: str, segment: str = "_global") -> str | None:
    """Thompson sample: draw from each arm's Beta posterior, return arg-max."""
    crm.init()
    with crm.connect() as con:
        rows = con.execute(
            "SELECT arm, alpha, beta FROM experiments "
            "WHERE experiment_id=? AND segment=? AND status='active'",
            (experiment_id, segment),
        ).fetchall()
        if not rows:
            return None
        best_arm, best_draw = None, -1.0
        for r in rows:
            draw = random.betavariate(r["alpha"], r["beta"])
            if draw > best_draw:
                best_draw, best_arm = draw, r["arm"]
        return best_arm


def record(experiment_id: str, arm: str, reward: float, segment: str = "_global") -> None:
    """Record an outcome. Reward in [0, 1] for binary; can exceed for cascading."""
    crm.init()
    with crm.connect() as con:
        con.execute(
            "UPDATE experiments SET "
            "  alpha = alpha + ?, "
            "  beta = beta + ?, "
            "  n_samples = n_samples + 1, "
            "  cumulative_reward = cumulative_reward + ?, "
            "  updated_at = CURRENT_TIMESTAMP "
            "WHERE experiment_id=? AND arm=? AND segment=?",
            (
                max(0.0, reward),
                max(0.0, 1.0 - min(reward, 1.0)),
                reward,
                experiment_id, arm, segment,
            ),
        )
        con.commit()


def posteriors(experiment_id: str | None = None) -> list[dict]:
    """Read current posteriors for one or all experiments."""
    crm.init()
    with crm.connect() as con:
        if experiment_id:
            rows = con.execute(
                "SELECT * FROM experiments WHERE experiment_id=? ORDER BY segment, arm",
                (experiment_id,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM experiments ORDER BY experiment_id, segment, arm"
            ).fetchall()
        return [dict(r) for r in rows]


def render_status_md() -> str:
    exps = load_experiments()
    rows = posteriors()
    by_id: dict[str, list[dict]] = {}
    for r in rows:
        by_id.setdefault(r["experiment_id"], []).append(r)
    lines = [
        "# Experiments status",
        "",
        f"_{len(exps)} pre-registered experiments. {len(rows)} arms tracked._",
        "",
    ]
    for exp in exps:
        eid = exp["id"]
        lines.append(f"## `{eid}` ({exp['layer']}) · {exp.get('status', 'planned')}")
        lines.append("")
        lines.append(f"**Hypothesis:** {exp.get('hypothesis', '').strip()}")
        lines.append("")
        lines.append(f"**Reward:** {exp.get('reward_signal', exp.get('reward_cascade', '—'))}")
        lines.append("")
        lines.append(f"**Kill criterion:** {exp.get('kill_criterion', '—').strip()}")
        lines.append("")
        lines.append(f"**Convergence target:** {exp.get('convergence_target', '—')}")
        lines.append("")
        if exp.get("current_default"):
            lines.append(f"**Current default arm:** `{exp['current_default']}`")
            lines.append("")
        arm_rows = by_id.get(eid, [])
        if arm_rows:
            lines.append("| segment | arm | n | mean reward | α | β |")
            lines.append("|---|---|---|---|---|---|")
            for r in arm_rows:
                mean = r["cumulative_reward"] / max(1, r["n_samples"])
                lines.append(
                    f"| {r['segment']} | `{r['arm']}` | {r['n_samples']} | "
                    f"{mean:.3f} | {r['alpha']:.2f} | {r['beta']:.2f} |"
                )
        else:
            lines.append("_(arms not yet seeded — run `python -m scripts.p2.experiments init`)_")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cmd", choices=["init", "status"])
    args = parser.parse_args()

    if args.cmd == "init":
        init_from_yaml()
        print("[experiments] initialized")
        return 0
    if args.cmd == "status":
        out = render_status_md()
        out_path = REPO_ROOT / "EXPERIMENTS.md"
        out_path.write_text(out)
        print(f"[experiments] wrote {out_path.relative_to(REPO_ROOT)}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
