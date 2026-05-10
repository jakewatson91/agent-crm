"""
Step 5 — chronological replay.

Walks all CRM posts in posted_at ASC order, advancing the simulated clock
to each post's timestamp. At each tick:
  1. Roll the clock forward to post.posted_at
  2. Refresh cumulative_score for the post's parent entities at that clock
  3. Evaluate triggers AS-OF that clock for those entities
  4. Emit a timeline entry to replay/<entity_slug>/timeline.md

Replay is deterministic and idempotent; you can re-run it after tweaking
thresholds in triggers.py and see the new firings.

Prereqs:
  - Posts already in CRM (run curate)
  - Posts already scored (run score)
  - Entities already comprehended + matched (run understand + match)

Usage:
    python -m scripts.p2.replay                # replay everything
    python -m scripts.p2.replay --reset        # wipe triggers + timelines first
    python -m scripts.p2.replay --entity-id emir_atli --entity-type lead
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import crm
from . import triggers as triggers_mod
from ._common import REPO_ROOT

REPLAY_DIR = REPO_ROOT / "replay"
SUMMARY_PATH = REPLAY_DIR / "_summary.md"


def _slug(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}__{entity_id}"


def _parse_iso(s: str) -> datetime:
    s = (s or "").rstrip("Z")
    if "." in s:
        head, dot, frac = s.partition(".")
        s = f"{head}.{frac[:6]}"
    if "+" not in s and "-" not in s[10:]:
        dt = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    else:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _open_timeline_writers() -> dict[str, list[str]]:
    """Per-entity buffers for timeline lines. Keyed by entity slug."""
    return {}


def _write_timelines(buffers: dict[str, list[str]]) -> None:
    REPLAY_DIR.mkdir(parents=True, exist_ok=True)
    with crm.connect() as con:
        for slug, lines in buffers.items():
            # Finalize the header now that cumulative + triggers are at their end-state
            entity_type, entity_id = slug.split("__", 1)
            name = _entity_name_for(con, entity_type, entity_id)
            header = _render_timeline_header(con, entity_type, entity_id, name)
            # Replace the placeholder with the rendered header
            if lines and lines[0] == "__HEADER_PLACEHOLDER__":
                lines = header + lines[1:]
            else:
                lines = header + lines
            d = REPLAY_DIR / slug
            d.mkdir(parents=True, exist_ok=True)
            (d / "timeline.md").write_text("\n".join(lines))


def _entity_name_for(con, entity_type: str, entity_id: str) -> str:
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    row = con.execute(f"SELECT name FROM {table} WHERE {id_col}=?", (entity_id,)).fetchone()
    return row["name"] if row else entity_id


def _render_timeline_header(con, entity_type: str, entity_id: str, name: str) -> list[str]:
    """Header block at the top of each entity's timeline.md — current state +
    ICP fit + theme + pointers to the artifacts the demo references.
    """
    import json as _json
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    row = con.execute(f"SELECT * FROM {table} WHERE {id_col}=?", (entity_id,)).fetchone()
    cum = row["cumulative_score"] if row else 0.0
    alignment = (row["sim_alignment_score"] if row else 0.0) or 0.0
    status = row["status"] if row else "watching"
    icp_themes_raw = (row["icp_themes"] if row else "") or "[]"
    try:
        icp_themes = _json.loads(icp_themes_raw)
    except (ValueError, TypeError):
        icp_themes = []
    icp_md = row["icp_md"] if row else ""
    icp_note_hook = (row["icp_note_hook"] if row else "") or ""

    n_triggers = con.execute(
        "SELECT COUNT(*) FROM triggers WHERE entity_type=? AND entity_id=?",
        (entity_type, entity_id),
    ).fetchone()[0]
    n_posts = con.execute(
        f"SELECT COUNT(*) FROM posts WHERE {id_col}=?", (entity_id,)
    ).fetchone()[0]

    # Link to the mothership prompt if it exists (leads only)
    if entity_type == "lead":
        mp_path = REPO_ROOT / "golden" / entity_id / "mothership_prompt.md"
    else:
        mp_path = None

    urgency_raw = (row["decision_urgency"] if row else "") or ""
    urgency_marker = {
        "active_build": "🚧 ACTIVE_BUILD (shipping a relevant system right now)",
        "building_soon": "📋 BUILDING_SOON (scoping or hiring for it)",
        "philosophical": "💭 PHILOSOPHICAL (thesis-level posting, no concrete build)",
        "quiet": "💤 QUIET (not posting on theme right now)",
    }.get(urgency_raw.lower(), f"❓ {urgency_raw.upper()}" if urgency_raw else "")

    lines = [
        f"# Timeline: {name} ({entity_type})",
        "",
        f"**`{entity_id}`** · status: `{status}` · alignment: **{alignment:.3f}** · "
        f"cumulative: **{cum:.2f}** · {n_posts} posts · {n_triggers} triggers fired",
        "",
    ]
    if urgency_marker:
        lines.append(f"**Decision urgency:** {urgency_marker}")
    if icp_themes:
        lines.append(f"**Themes:** {' · '.join(icp_themes)}")
    if icp_note_hook:
        lines.append("")
        lines.append(f"**Suggested opener (when no specific workflow fits):**")
        lines.append("")
        lines.append(f"> {icp_note_hook}")
    lines.append("")
    lines.append("**Demo references:**")
    lines.append(f"- understanding doc: [`understand/{entity_type}__{entity_id}.md`](../../understand/{entity_type}__{entity_id}.md)")
    lines.append(f"- match (sales-pitch + corpus candidates): [`match/{entity_type}__{entity_id}.md`](../../match/{entity_type}__{entity_id}.md)")
    if mp_path and mp_path.exists():
        lines.append(f"- **mothership prompt: [`golden/{entity_id}/mothership_prompt.md`](../../golden/{entity_id}/mothership_prompt.md)** ← the paste-into-Sim asset")

    if icp_md:
        lines.append("")
        lines.append("<details>")
        lines.append("<summary>📋 full ICP classification audit</summary>")
        lines.append("")
        lines.append(icp_md)
        lines.append("")
        lines.append("</details>")
    lines.append("")
    lines.append("---")
    lines.append("")
    return lines


def _sanitize_title(s: str) -> str:
    """Collapse whitespace/newlines so the markdown link renders on one line."""
    if not s:
        return "(untitled)"
    cleaned = " ".join(s.split())
    return cleaned[:80]


def render_summary(rows: list[dict]) -> str:
    rows = sorted(rows, key=lambda r: -r["triggers_fired"])
    lines = [
        "# Replay summary",
        "",
        "| type    | name                       | posts | peak | cumulative | triggers |",
        "|---------|----------------------------|-------|------|-----------|----------|",
    ]
    for r in rows:
        lines.append(
            f"| {r['entity_type']:<7} | {r['name'][:26]:<26} | {r['posts']:>5} | "
            f"{r['peak_intent']:>2}/10 | {r['final_cum']:>9.2f} | {r['triggers_fired']:>8} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true",
                        help="wipe replay/ and triggers/ + clear triggers table before replaying")
    parser.add_argument("--entity-id", default=None,
                        help="restrict replay to one entity_id (requires --entity-type)")
    parser.add_argument("--entity-type", choices=["account", "lead"], default=None)
    args = parser.parse_args()

    crm.init()

    if args.reset:
        if REPLAY_DIR.exists():
            shutil.rmtree(REPLAY_DIR)
        triggers_dir = REPO_ROOT / "triggers"
        if triggers_dir.exists():
            shutil.rmtree(triggers_dir)
        with crm.connect() as con:
            con.execute("DELETE FROM triggers")
            # Reset entity status to baseline + zero cumulative
            con.execute("UPDATE accounts SET cumulative_score=0, status='watching'")
            con.execute("UPDATE leads SET cumulative_score=0, status='watching'")
            con.commit()
        print("[replay] reset: triggers/ and replay/ cleared, entity state baseline")

    # Pull all posts in chronological order
    with crm.connect() as con:
        all_posts = crm.fetch_all_posts_chronological(con)

    if not all_posts:
        print("[replay] no posts in CRM — run curate first")
        return 1

    # Filter by entity if requested
    if args.entity_id and args.entity_type:
        id_col = "account_id" if args.entity_type == "account" else "lead_id"
        all_posts = [p for p in all_posts if p[id_col] == args.entity_id]
        if not all_posts:
            print(f"[replay] no posts attached to {args.entity_type}={args.entity_id}")
            return 1

    # Per-entity timeline buffers + stats accumulators
    timelines: dict[str, list[str]] = {}
    entity_stats: dict[tuple[str, str], dict] = {}

    print(f"[replay] walking {len(all_posts)} posts chronologically...")
    started_iso = all_posts[0]["posted_at"]
    ended_iso = all_posts[-1]["posted_at"]
    print(f"  range: {started_iso} → {ended_iso}")

    last_clock_per_entity: dict[tuple[str, str], datetime] = {}

    for i, post in enumerate(all_posts, 1):
        clock = _parse_iso(post["posted_at"])
        # Both lead and account get a tick if both are set
        affected: list[tuple[str, str]] = []
        if post["lead_id"]:
            affected.append(("lead", post["lead_id"]))
        if post["account_id"]:
            affected.append(("account", post["account_id"]))

        with crm.connect() as con:
            for et, eid in affected:
                slug = _slug(et, eid)
                if slug not in timelines:
                    name = _entity_name_for(con, et, eid)
                    # Header is finalized at end-of-replay (need final cum + trigger count).
                    # Reserve a placeholder marker we'll replace.
                    timelines[slug] = ["__HEADER_PLACEHOLDER__"]
                    entity_stats[(et, eid)] = {
                        "entity_type": et, "entity_id": eid, "name": name,
                        "posts": 0, "peak_intent": 0, "final_cum": 0.0,
                        "triggers_fired": 0,
                    }

                stats = entity_stats[(et, eid)]
                stats["posts"] += 1
                stats["peak_intent"] = max(stats["peak_intent"], post["intent_score"] or 0)

                # Cumulative score for this entity, as-of clock
                old_cum = 0.0
                table = "accounts" if et == "account" else "leads"
                id_col = "account_id" if et == "account" else "lead_id"
                pre = con.execute(
                    f"SELECT cumulative_score FROM {table} WHERE {id_col}=?", (eid,)
                ).fetchone()
                if pre:
                    old_cum = pre["cumulative_score"] or 0.0
                # Recompute using only posts <= clock (replay-correct view)
                # This requires fetching posts where posted_at <= clock
                cutoff_iso = clock.isoformat()
                hist_rows = con.execute(
                    f"SELECT * FROM posts WHERE {id_col}=? AND posted_at <= ? ORDER BY posted_at",
                    (eid, cutoff_iso),
                ).fetchall()
                new_cum = crm.cumulative_score_for_posts(hist_rows, now=clock)
                con.execute(
                    f"UPDATE {table} SET cumulative_score=?, last_evidence_at=? WHERE {id_col}=?",
                    (new_cum, clock.isoformat(), eid),
                )
                stats["final_cum"] = new_cum

                # Append to entity's timeline — clean per-tick format with
                # an expandable audit block.
                clock_short = clock.isoformat()[:10]
                title = _sanitize_title(post["title"] or "")
                timelines[slug].append(
                    f"### {clock_short} · {post['channel']} · "
                    f"[{title}]({post['url']})"
                )

                arrow = "↑" if new_cum > old_cum else ("→" if new_cum == old_cum else "↓")
                delta_str = f"{new_cum - old_cum:+.2f}" if new_cum != old_cum else "no change"
                conf = post["score_confidence"] or "—"
                problem = (post["inferred_problem"] or "").strip()
                quote = (post["signal_quote"] or "").strip()

                timelines[slug].append(
                    f"- score: **{post['intent_score'] or 0}/10** ({conf} confidence)  ·  "
                    f"cumulative {old_cum:.2f} {arrow} **{new_cum:.2f}**  (Δ {delta_str})"
                )
                if problem:
                    timelines[slug].append(f"- inferred problem: {problem[:200]}")
                if quote and len(quote) >= 20:
                    timelines[slug].append(f"- signal: _\"{quote[:200]}\"_")

                # Surface this post's top Sim primitive match inline (above the
                # collapsed audit block) so the demo can show "this specific
                # post is closest to <Sim primitive>" without expanding.
                top_corpus_md = (post["top_corpus_match_md"] or "").strip()
                if top_corpus_md:
                    # Just show the top-1 inline; full list goes in the audit
                    first_line = top_corpus_md.split("\n", 1)[0]
                    timelines[slug].append(f"- closest Sim primitive: {first_line.lstrip('- ')}")

                # Expandable audit block: full post text + LLM rationale +
                # per-post corpus matches.
                full_text = (post["text"] or "").strip()
                score_md = (post["score_md"] or "").strip()
                if full_text or score_md or top_corpus_md:
                    timelines[slug].append("")
                    timelines[slug].append("<details>")
                    timelines[slug].append("<summary>📋 audit — full post text + score rationale + top Sim matches</summary>")
                    timelines[slug].append("")
                    if top_corpus_md:
                        timelines[slug].append("**Top Sim corpus matches for this post (cosine on post embedding):**")
                        timelines[slug].append("")
                        timelines[slug].append(top_corpus_md)
                        timelines[slug].append("")
                    if full_text:
                        timelines[slug].append("**Full post text:**")
                        timelines[slug].append("")
                        for line in full_text[:2000].splitlines():
                            timelines[slug].append(f"> {line}" if line else ">")
                        if len(full_text) > 2000:
                            timelines[slug].append(f"> _(truncated; {len(full_text)} chars total)_")
                        timelines[slug].append("")
                    if score_md:
                        timelines[slug].append("**Score rationale (LLM output):**")
                        timelines[slug].append("")
                        timelines[slug].append(score_md)
                        timelines[slug].append("")
                    timelines[slug].append("</details>")

                # Evaluate triggers as-of clock for this entity
                fresh_row = con.execute(
                    f"SELECT * FROM {table} WHERE {id_col}=?", (eid,)
                ).fetchone()
                fires = triggers_mod.evaluate_for_entity(con, et, fresh_row, as_of=clock)
                if fires:
                    n_new = triggers_mod.fire_and_persist(con, et, fresh_row, fires, as_of=clock)
                    if n_new:
                        # Make trigger fires visually distinct
                        timelines[slug].append("")
                        for f in fires:
                            timelines[slug].append(
                                f"> **🚨 TRIGGER FIRED — `{f['trigger_type']}`**  "
                                f"\n> {f['summary']}"
                            )
                        stats["triggers_fired"] += n_new
                timelines[slug].append("")

            con.commit()

    _write_timelines(timelines)

    summary = render_summary(list(entity_stats.values()))
    SUMMARY_PATH.write_text(summary)

    # Log replay run summary
    total_triggers = sum(s["triggers_fired"] for s in entity_stats.values())
    with crm.connect() as con:
        crm.log_decision(
            con, action="replay",
            summary=f"replayed {len(all_posts)} posts across {len(entity_stats)} entities; "
                    f"{total_triggers} triggers fired",
            metadata={"reset": args.reset, "n_posts": len(all_posts),
                       "range_start": started_iso, "range_end": ended_iso},
        )
        con.commit()

    print(f"\n[replay] complete")
    print(f"  timelines:  {REPLAY_DIR.relative_to(REPO_ROOT)}/")
    print(f"  summary:    {SUMMARY_PATH.relative_to(REPO_ROOT)}")
    print()
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
