"""
Render CONSOLE.md — the single-page snapshot of pipeline state.

Sections:
  1. Leads + Accounts table  — sorted desc by cumulative_score, with status
                                + trigger count + top template match
  2. Trigger inbox            — pending triggers with evidence
  3. Decision timeline        — last 30 actions from decisions table
  4. File index               — what each directory means

Run after any pipeline step:
    python -m scripts.p2.console

Output: CONSOLE.md at the repo root.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import crm
from ._common import REPO_ROOT

CONSOLE_PATH = REPO_ROOT / "CONSOLE.md"


def render_entities_section(con) -> list[str]:
    import json as _json
    lines = [
        "## 1. Leads + Accounts",
        "",
        "_Sorted by (alignment desc, cumulative desc). Two targeting axes: alignment_",
        "_(entity-level cosine to Sim corpus) + cumulative (decay-weighted post-level cosine)._",
        "_Decision urgency is the action-shape selector — drives WHAT we send when we engage:_",
        "_active_build → ship Mothership prompt; philosophical → discovery note; quiet → drop._",
        "",
        "| Type    | Name                       | Align | Cum.   | Urgency           | Posts | Trig | Top theme                              |",
        "|---------|----------------------------|-------|--------|-------------------|-------|------|----------------------------------------|",
    ]
    rows = []
    urgency_rank = {"active_build": 0, "building_soon": 1, "philosophical": 2, "quiet": 3}

    for et in ("lead", "account"):
        table = "accounts" if et == "account" else "leads"
        id_col = "account_id" if et == "account" else "lead_id"
        for r in con.execute(f"SELECT * FROM {table}").fetchall():
            eid = r[id_col]
            n_posts = con.execute(
                f"SELECT COUNT(*) FROM posts WHERE {id_col}=?", (eid,)
            ).fetchone()[0]
            n_triggers = con.execute(
                "SELECT COUNT(*) FROM triggers WHERE entity_type=? AND entity_id=?",
                (et, eid),
            ).fetchone()[0]
            urgency = (r["decision_urgency"] or "").lower()
            try:
                themes = _json.loads(r["icp_themes"] or "[]")
            except (ValueError, TypeError):
                themes = []
            top_theme = themes[0] if themes else ""
            rows.append({
                "type": et, "name": r["name"], "cum": r["cumulative_score"] or 0,
                "posts": n_posts, "triggers": n_triggers,
                "urgency": urgency, "top_theme": top_theme,
                "alignment": r["sim_alignment_score"] or 0.0,
            })

    rows.sort(key=lambda x: (-x["alignment"], -x["cum"], urgency_rank.get(x["urgency"], 9)))

    urgency_marker = {
        "active_build": "🚧 active_build",
        "building_soon": "📋 building_soon",
        "philosophical": "💭 philosophical",
        "quiet": "💤 quiet",
    }
    for r in rows:
        urg = urgency_marker.get(r["urgency"], "—")
        lines.append(
            f"| {r['type']:<7} | {r['name'][:26]:<26} | "
            f"{r['alignment']:>5.3f} | "
            f"{r['cum']:>6.2f} | {urg:<17} | {r['posts']:>5} | {r['triggers']:>4} | "
            f"{r['top_theme'][:38]:<38} |"
        )
    lines.append("")
    return lines


def render_trigger_inbox(con) -> list[str]:
    rows = con.execute("""
        SELECT t.*,
               CASE WHEN t.entity_type='account'
                    THEN (SELECT name FROM accounts WHERE account_id=t.entity_id)
                    ELSE (SELECT name FROM leads WHERE lead_id=t.entity_id) END AS name,
               (SELECT url FROM posts WHERE post_id=t.evidence_post_id) AS evidence_url,
               (SELECT intent_score FROM posts WHERE post_id=t.evidence_post_id) AS evidence_score
        FROM triggers t
        WHERE t.status = 'pending'
        ORDER BY t.fired_at_post_time DESC
    """).fetchall()

    lines = [
        "## 2. Trigger inbox (pending)",
        "",
        f"_{len(rows)} triggers awaiting action._",
        "",
    ]
    if not rows:
        lines.append("(no pending triggers)")
        lines.append("")
        return lines

    lines += [
        "| Fired (post-time) | Type                | Entity                       | Evidence post (score) |",
        "|-------------------|---------------------|------------------------------|------------------------|",
    ]
    for r in rows:
        fired = (r["fired_at_post_time"] or "")[:10]
        ev = "—"
        if r["evidence_url"]:
            short = r["evidence_url"][:38]
            ev = f"{short}... ({r['evidence_score'] or '?'}/10)"
        lines.append(
            f"| {fired:<17} | {r['trigger_type']:<19} | {(r['name'] or r['entity_id'])[:28]:<28} | {ev[:22]:<22} |"
        )
    lines.append("")
    lines.append("_Trigger cards live at `triggers/<entity_slug>__<ts>__<type>.md`._")
    lines.append("")
    return lines


def render_decision_timeline(con) -> list[str]:
    rows = con.execute(
        "SELECT * FROM decisions ORDER BY happened_at DESC, decision_id DESC LIMIT 30"
    ).fetchall()

    lines = [
        "## 3. Decision timeline",
        "",
        f"_Last 30 actions. Newest first._",
        "",
    ]
    if not rows:
        lines.append("(no decisions logged yet)")
        lines.append("")
        return lines
    for r in rows:
        ts = (r["happened_at"] or "")[:19]
        action = r["action"] or "?"
        summary = r["summary"] or ""
        ent_str = ""
        if r["entity_type"] and r["entity_id"]:
            ent_str = f"  [{r['entity_type']}:{r['entity_id']}]"
        lines.append(f"- `{ts}`  **{action}**  {summary}{ent_str}")
    lines.append("")
    return lines


def render_file_index() -> list[str]:
    return [
        "## 4. File index",
        "",
        "**Where things live:**",
        "",
        "| Path                          | What's there                                                |",
        "|-------------------------------|-------------------------------------------------------------|",
        "| `config/golden_leads.yaml`    | The 5 leads + accounts being watched (editable)              |",
        "| `golden/_manual_posts.json`   | Hand-curated founder-voice posts (committable; the truth)    |",
        "| `golden/<lead_id>/posts.json` | Per-lead Exa-scraped news + jobs (auto-curated)              |",
        "| `posts/<channel>/<id>.json`   | Per-post fixture (raw scraped + manual)                       |",
        "| `posts/_inventory.md`         | Channel breakdown of scraped posts                            |",
        "| `understand/<entity_slug>.md` | Comprehension doc per lead/account (editable)                 |",
        "| `score/<entity_slug>.md`      | Per-entity score card with rubric application                  |",
        "| `score/_ranked.md`            | All entities ranked by cumulative score                        |",
        "| `match/<entity_slug>.md`      | Top template matches per entity (editable: confirm/reject)     |",
        "| `match/_inbox.md`             | All entities awaiting your match decision                      |",
        "| `replay/<entity_slug>/timeline.md` | Per-entity chronological replay (the demo asset)         |",
        "| `replay/_summary.md`          | Replay summary across all entities                              |",
        "| `triggers/<entity>__<ts>__<type>.md` | One file per fired trigger                            |",
        "| `prompts/{understand,score,match}.md` | Editable system prompts for each step                  |",
        "| `fewshots/<step>.jsonl`        | User-edit examples that improve next runs                       |",
        "| `scripts/.cache/crm.sqlite`    | THE source of truth: accounts, leads, posts, templates, matches, triggers, decisions |",
        "| `_archive/`                    | Old/dead code from prior approaches                              |",
        "",
        "**Pipeline order:**",
        "",
        "1. `python -m scripts.p2.crm --reset`        — wipe + rebuild schema",
        "2. `python -m scripts.p2.index_templates sim_templates.json` — load 82 templates",
        "3. `python -m scripts.p2.ingest_manual`      — load curated founder posts",
        "4. `python -m scripts.p2.curate`             — Exa-scrape company news + jobs",
        "5. `python -m scripts.p2.understand`         — comprehend each entity",
        "6. `python -m scripts.p2.score --emit-cards` — score posts + roll up cumulative",
        "7. `python -m scripts.p2.match`              — cosine match against templates",
        "8. `python -m scripts.p2.replay --reset`     — chronological replay + fire triggers",
        "9. `python -m scripts.p2.console`            — render this CONSOLE.md",
        "",
        "**Edit + feedback flow:**",
        "",
        "- Edit any `<step>/<entity_slug>.md` file directly",
        "- Run `python -m scripts.p2.feedback <step>` to capture diff as fewshots + push to CRM",
        "- For match: edit `**Decision:**` line to `confirm` / `reject` / `override: <template_id>`",
        "- For all steps: change `## Drop this row` to `yes` to mark entity as dropped",
        "",
    ]


def render_header(con) -> list[str]:
    s = crm.stats(con)
    return [
        "# CONSOLE — pipeline state",
        "",
        f"_Last rendered: {datetime.now(timezone.utc).isoformat()}_",
        "",
        f"**CRM:** {s['accounts']} accounts · {s['leads']} leads · {s['posts']} posts "
        f"({s['posts_scored']} scored) · {s['templates']} templates · "
        f"{s['triggers']} triggers fired ({s['triggers_pending']} pending) · "
        f"{s['decisions']} decisions logged",
        "",
        "---",
        "",
    ]


def main() -> int:
    crm.init()
    sections: list[str] = []
    with crm.connect() as con:
        sections += render_header(con)
        sections += render_entities_section(con)
        sections += render_trigger_inbox(con)
        sections += render_decision_timeline(con)
    sections += render_file_index()
    CONSOLE_PATH.write_text("\n".join(sections))
    print(f"[console] wrote {CONSOLE_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
