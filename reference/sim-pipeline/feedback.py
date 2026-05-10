"""
Capture user edits as fewshots for the next run.

For each <step>/<slug>.md whose hash differs from <step>/<slug>.original.md:
  - Append (input, original_output, user_edit) to fewshots/<step>.jsonl
  - Update the .original.md to match the edit
  - For step=understand: re-embed the entity with the edited text
  - For step=match: parse Decision line, update matches.status
  - For all steps: parse "Drop this row" directive, mark entity status='dropped'

Slug convention: `<entity_type>__<entity_id>` (e.g. `lead__emir_atli`).

Usage:
    python -m scripts.p2.feedback understand
    python -m scripts.p2.feedback score
    python -m scripts.p2.feedback match
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from . import crm
from ._common import (
    REPO_ROOT, FEWSHOTS_DIR, append_fewshot, detect_edit, hash_text,
)

UNDERSTAND_DIR = REPO_ROOT / "understand"
SCORE_DIR = REPO_ROOT / "score"
MATCH_DIR = REPO_ROOT / "match"

_DROP_RE = re.compile(r"^\s*##\s*Drop this row\s*\n+\s*(yes|true|drop)\b", re.M | re.I)


def _step_dir(step: str) -> Path:
    return {"understand": UNDERSTAND_DIR, "score": SCORE_DIR, "match": MATCH_DIR}[step]


def _parse_slug(slug: str) -> tuple[str, str] | None:
    """Parse '<entity_type>__<entity_id>' → ('account'|'lead', entity_id).
    Returns None for legacy non-prefixed slugs (best-effort: assume 'lead')."""
    if "__" in slug:
        et, _, eid = slug.partition("__")
        if et in ("account", "lead"):
            return et, eid
    return None


def _drop_entity(entity_type: str, entity_id: str) -> None:
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    with crm.connect() as con:
        con.execute(f"UPDATE {table} SET status='dropped' WHERE {id_col}=?", (entity_id,))
        con.commit()


def _parse_drop_directive(md: str) -> bool:
    return bool(_DROP_RE.search(md))


def _input_for(step: str, slug: str) -> str:
    parsed = _parse_slug(slug)
    if not parsed:
        return slug
    et, eid = parsed
    if step == "understand":
        with crm.connect() as con:
            row = crm.fetch_entity(con, et, eid)
            posts = crm.fetch_posts_for_entity(con, et, eid, limit=10)
        if not row:
            return f"{et}:{eid}"
        head = f"{et}: {row['name']}"
        return head + "\n" + "\n".join(f"  post: {p['url']}" for p in posts)
    if step == "score":
        with crm.connect() as con:
            row = crm.fetch_entity(con, et, eid)
        return f"{et}: {(row['name'] if row else eid)}\n\nunderstanding:\n{(row['understanding_md'] if row else '')[:2000]}"
    if step == "match":
        with crm.connect() as con:
            row = crm.fetch_entity(con, et, eid)
            matches = con.execute(
                "SELECT template_id, cosine_score FROM matches "
                "WHERE entity_type=? AND entity_id=? "
                "ORDER BY cosine_score DESC LIMIT 5",
                (et, eid),
            ).fetchall()
        head = f"{et}: {(row['name'] if row else eid)}"
        return head + "\n" + "\n".join(f"  candidate: {m['template_id']} (cosine {m['cosine_score']:.3f})" for m in matches)
    return slug


def _process_match_decision(slug: str, edited: str) -> tuple[int, int, int]:
    """Parse '**Decision:** confirm|reject|override: <id>'. Returns (confirmed, rejected, overridden)."""
    parsed = _parse_slug(slug)
    if not parsed:
        return 0, 0, 0
    et, eid = parsed

    decision_match = re.search(
        r"\*\*Decision:\*\*\s*(confirm|reject|override\s*[:\-]\s*([a-z0-9_]+))",
        edited, re.I,
    )
    if not decision_match:
        return 0, 0, 0
    raw = decision_match.group(1).lower()
    confirmed = rejected = overridden = 0

    with crm.connect() as con:
        if raw == "confirm":
            top = con.execute(
                "SELECT template_id FROM matches WHERE entity_type=? AND entity_id=? AND status='auto' "
                "ORDER BY cosine_score DESC LIMIT 1", (et, eid),
            ).fetchone()
            if top:
                con.execute(
                    "UPDATE matches SET status='user_confirmed' "
                    "WHERE entity_type=? AND entity_id=? AND template_id=?",
                    (et, eid, top["template_id"]),
                )
                confirmed = 1
        elif raw == "reject":
            con.execute(
                "UPDATE matches SET status='user_rejected' "
                "WHERE entity_type=? AND entity_id=? AND status='auto'",
                (et, eid),
            )
            rejected = con.execute("SELECT changes()").fetchone()[0]
        elif raw.startswith("override"):
            chosen = decision_match.group(2).lower()
            con.execute(
                "UPDATE matches SET status='user_rejected' "
                "WHERE entity_type=? AND entity_id=? AND status='auto'",
                (et, eid),
            )
            con.execute(
                """INSERT OR REPLACE INTO matches
                   (entity_type, entity_id, template_id, cosine_score, matched_at, status, reasoning)
                   VALUES (?, ?, ?, COALESCE((SELECT cosine_score FROM matches
                       WHERE entity_type=? AND entity_id=? AND template_id=?), 0),
                       CURRENT_TIMESTAMP, 'user_confirmed', 'manual override')""",
                (et, eid, chosen, et, eid, chosen),
            )
            overridden = 1
        con.commit()
    return confirmed, rejected, overridden


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=["understand", "score", "match"])
    args = parser.parse_args()

    step_dir = _step_dir(args.step)
    if not step_dir.exists():
        print(f"[feedback] no {args.step} outputs (dir missing)")
        return 0

    captured = re_embedded = dropped = confirmed = rejected = overridden = 0
    for md_path in sorted(step_dir.glob("*.md")):
        if md_path.name.startswith("_") or md_path.name.endswith(".original.md"):
            continue
        slug = md_path.stem
        diff = detect_edit(step_dir, slug)
        if diff is None:
            continue
        original, edited = diff

        append_fewshot(args.step,
                       input=_input_for(args.step, slug),
                       original_output=original,
                       user_edit=edited)
        captured += 1

        # Drop directive applies to all steps
        if _parse_drop_directive(edited):
            parsed = _parse_slug(slug)
            if parsed:
                _drop_entity(parsed[0], parsed[1])
                dropped += 1
                print(f"  DROPPED: {slug}")
                (step_dir / f"{slug}.original.md").write_text(edited)
                continue

        if args.step == "understand":
            parsed = _parse_slug(slug)
            if parsed:
                et, eid = parsed
                with crm.connect() as con:
                    crm.update_entity_understanding(con, et, eid, edited)
                    con.commit()
                re_embedded += 1
        elif args.step == "match":
            c, r, o = _process_match_decision(slug, edited)
            confirmed += c
            rejected += r
            overridden += o

        (step_dir / f"{slug}.original.md").write_text(edited)
        print(f"  captured: {slug}")

    if captured or dropped or score_updated or confirmed_total or rejected_total or overridden_total:
        with crm.connect() as con:
            crm.log_decision(
                con, action=f"feedback_{args.step}",
                summary=f"captured {captured} edits; dropped {dropped}; score_updated {score_updated}; "
                        f"confirmed {confirmed_total}; rejected {rejected_total}; overridden {overridden_total}",
            )
            con.commit()

    print()
    print(f"[feedback] step={args.step}")
    print(f"  edits captured: {captured}")
    if dropped:
        print(f"  rows dropped: {dropped}")
    if args.step == "understand":
        print(f"  entities re-embedded: {re_embedded}")
    if args.step == "match":
        print(f"  confirmed: {confirmed}  rejected: {rejected}  overridden: {overridden}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
