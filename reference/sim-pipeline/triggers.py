"""
Step 4 — fire triggers.

Two trigger conditions, evaluated against the CRM at a given clock time
(default: now; replay engine passes a historical clock). Triggers are
deduplicated per (entity_type, entity_id, trigger_type, evidence_post_id) so
re-running is idempotent.

  Condition A — individual_signal:
    Any post in last 72h with intent_score >= INDIVIDUAL_THRESHOLD
    (configurable; default 7).
    evidence_post_id = the post that triggered it.

  Condition B — long_term_threshold:
    Entity's cumulative_score >= CUMULATIVE_THRESHOLD
    (configurable; default 12).
    evidence_post_id = null (cumulative; no single post).
    Only fires once per crossing — once entity is 'qualified' or
    'triggered', subsequent ticks won't re-fire B.

Output: one markdown card per fire at triggers/<entity_slug>__<ts>.md.

Usage (standalone — useful for debugging on the current state):
    python -m scripts.p2.triggers
    python -m scripts.p2.triggers --as-of 2026-04-30T12:00:00Z

Used by replay.py at each tick.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from . import crm
from ._common import REPO_ROOT

TRIGGERS_DIR = REPO_ROOT / "triggers"

INDIVIDUAL_THRESHOLD = 9        # intent_score required to fire condition A
CUMULATIVE_THRESHOLD = 18.0     # cumulative_score required to fire condition B
INDIVIDUAL_LOOKBACK_HOURS = 72  # how recent the post must be for condition A


def trigger_id_for(entity_type: str, entity_id: str, trigger_type: str,
                    evidence_post_id: Optional[str], fired_at: str) -> str:
    """Stable id so re-runs don't duplicate.

    For individual_signal: keyed by (entity, type, post). One trigger per post.
    For long_term_threshold: keyed by (entity, type) ONLY — fires once when
    cumulative first crosses, then doesn't re-fire. If user acts on it and
    we want to re-trigger after a drop+recross, we'd add a re-trigger
    mechanism explicitly. For now: once per entity.
    """
    if trigger_type == "individual_signal":
        key = f"{entity_type}|{entity_id}|individual|{evidence_post_id or ''}"
    else:
        key = f"{entity_type}|{entity_id}|cumulative"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def _entity_table(et: str) -> tuple[str, str]:
    return ("accounts", "account_id") if et == "account" else ("leads", "lead_id")


def _slug(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}__{entity_id}"


def _ts_clean(ts: str) -> str:
    return re.sub(r"[^0-9]", "", ts)[:14]


def render_trigger_md(entity_type: str, entity_row, trigger_type: str,
                       evidence_post_row, cumulative: float,
                       fired_at: str, top_match: Optional[dict] = None) -> str:
    name = entity_row["name"]
    lines = [
        f"# Trigger: {name} · {trigger_type}",
        "",
        f"**Entity:** {entity_type} `{entity_row['account_id' if entity_type == 'account' else 'lead_id']}`",
        f"**Fired at (post-time):** {fired_at}",
        f"**Trigger type:** {trigger_type}",
        f"**Cumulative score:** {cumulative:.2f}",
    ]
    if evidence_post_row is not None:
        lines += [
            f"**Evidence post:** {evidence_post_row['url']}",
            f"  - posted_at: {evidence_post_row['posted_at']}",
            f"  - intent_score: {evidence_post_row['intent_score']}/10",
            f"  - signal quote: {(evidence_post_row['signal_quote'] or '')[:200]!r}",
        ]
    if top_match:
        lines += [
            f"",
            f"**Top template match:** {top_match['name']} (cosine {top_match['cosine_score']:.3f})",
            f"  - template_id: `{top_match['template_id']}`",
            f"  - category: {top_match['category']}",
        ]
    lines += [
        "",
        f"**Why this fired:**",
    ]
    if trigger_type == "individual_signal":
        lines.append(f"  Single post with intent_score >= {INDIVIDUAL_THRESHOLD} arrived in last "
                     f"{INDIVIDUAL_LOOKBACK_HOURS}h.")
    else:
        lines.append(f"  Cumulative score (decayed, 14d window) crossed {CUMULATIVE_THRESHOLD}.")
    lines.append("")
    lines.append(f"## Status")
    lines.append(f"pending")
    lines.append("")
    return "\n".join(lines)


def evaluate_for_entity(con, entity_type: str, entity_row, *, as_of: datetime) -> list[dict]:
    """Returns list of {trigger_type, evidence_post_id, fired_at, summary}.
    Doesn't write — caller persists.
    """
    fires: list[dict] = []
    id_col = "account_id" if entity_type == "account" else "lead_id"
    eid = entity_row[id_col]

    # Condition A: any post with intent_score >= threshold in last 72h before as_of
    cutoff_a = as_of - timedelta(hours=INDIVIDUAL_LOOKBACK_HOURS)
    rows = con.execute(
        f"SELECT * FROM posts WHERE {id_col} = ? AND intent_score >= ? "
        f"AND posted_at >= ? AND posted_at <= ? "
        f"ORDER BY posted_at ASC",
        (eid, INDIVIDUAL_THRESHOLD, cutoff_a.isoformat(), as_of.isoformat()),
    ).fetchall()
    for p in rows:
        fires.append({
            "trigger_type": "individual_signal",
            "evidence_post_id": p["post_id"],
            "fired_at": p["posted_at"],
            "summary": f"Single post intent_score={p['intent_score']}/10 in last 72h",
        })

    # Condition B: cumulative score >= threshold
    cum = entity_row["cumulative_score"] or 0.0
    if cum >= CUMULATIVE_THRESHOLD:
        # Use the most recent post posted_at as the fire time
        latest = con.execute(
            f"SELECT posted_at FROM posts WHERE {id_col}=? AND posted_at <= ? "
            f"ORDER BY posted_at DESC LIMIT 1",
            (eid, as_of.isoformat()),
        ).fetchone()
        fired_at = (latest["posted_at"] if latest else as_of.isoformat())
        fires.append({
            "trigger_type": "long_term_threshold",
            "evidence_post_id": None,
            "fired_at": fired_at,
            "summary": f"Cumulative score {cum:.1f} crossed {CUMULATIVE_THRESHOLD}",
        })

    return fires


def fire_and_persist(con, entity_type: str, entity_row, fires: list[dict],
                     as_of: datetime) -> int:
    """Persist fires to triggers table + write triggers/<slug>__<ts>.md per fire.
    Returns count of NEW (not previously seen) trigger writes.
    """
    if not fires:
        return 0
    TRIGGERS_DIR.mkdir(parents=True, exist_ok=True)
    id_col = "account_id" if entity_type == "account" else "lead_id"
    eid = entity_row[id_col]
    new_count = 0

    # Pre-compute the entity's top template match (best-effort)
    top_match = None
    matches = crm.cosine_match_entity_to_templates(con, entity_type, eid, top_k=1)
    if matches:
        top_match = matches[0]

    for fire in fires:
        tid = trigger_id_for(entity_type, eid, fire["trigger_type"],
                              fire["evidence_post_id"], fire["fired_at"])
        existing = con.execute(
            "SELECT trigger_id FROM triggers WHERE trigger_id=?", (tid,)
        ).fetchone()
        if existing:
            continue  # already fired

        # Fetch evidence post if relevant
        evidence_post_row = None
        if fire["evidence_post_id"]:
            evidence_post_row = con.execute(
                "SELECT * FROM posts WHERE post_id=?", (fire["evidence_post_id"],)
            ).fetchone()

        # Persist
        crm.insert_trigger(
            con,
            trigger_id=tid,
            entity_type=entity_type,
            entity_id=eid,
            trigger_type=fire["trigger_type"],
            evidence_post_id=fire["evidence_post_id"],
            fired_at_post_time=fire["fired_at"],
            evidence_summary=fire["summary"],
        )

        # Mark entity as triggered (if not already)
        table = "accounts" if entity_type == "account" else "leads"
        con.execute(f"UPDATE {table} SET status='triggered' WHERE {id_col}=?", (eid,))

        # Write per-trigger card
        md = render_trigger_md(
            entity_type, entity_row, fire["trigger_type"],
            evidence_post_row, entity_row["cumulative_score"] or 0.0,
            fire["fired_at"], top_match=top_match,
        )
        slug = f"{_slug(entity_type, eid)}__{_ts_clean(fire['fired_at'])}__{fire['trigger_type']}"
        (TRIGGERS_DIR / f"{slug}.md").write_text(md)
        new_count += 1
        print(f"  TRIGGER FIRED: {slug}")
        crm.log_decision(
            con,
            action="trigger_fired",
            summary=f"{fire['trigger_type']} for {entity_type} {eid}: {fire['summary']}",
            entity_type=entity_type,
            entity_id=eid,
            metadata={"trigger_id": tid, "trigger_type": fire["trigger_type"],
                      "evidence_post_id": fire["evidence_post_id"],
                      "fired_at_post_time": fire["fired_at"]},
        )

    return new_count


def evaluate_all(*, as_of: datetime) -> int:
    """Run trigger evaluation across all entities at the given clock time.
    Returns total NEW triggers fired across this evaluation.
    """
    crm.init()
    new_total = 0
    with crm.connect() as con:
        for et in ("lead", "account"):
            table, id_col = _entity_table(et)
            for entity in con.execute(
                f"SELECT * FROM {table} WHERE (status IS NULL OR status NOT IN ('dropped',))"
            ).fetchall():
                fires = evaluate_for_entity(con, et, entity, as_of=as_of)
                new_total += fire_and_persist(con, et, entity, fires, as_of)
        con.commit()
    return new_total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", default=None,
                        help="ISO timestamp clock — default now")
    args = parser.parse_args()

    if args.as_of:
        as_of = datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        if as_of.tzinfo is None:
            as_of = as_of.replace(tzinfo=timezone.utc)
    else:
        as_of = datetime.now(timezone.utc)

    print(f"[triggers] evaluating at {as_of.isoformat()}")
    n = evaluate_all(as_of=as_of)
    print(f"[triggers] {n} new fires")

    with crm.connect() as con:
        s = crm.stats(con)
    print(f"  triggers in CRM: total={s['triggers']}  pending={s['triggers_pending']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
