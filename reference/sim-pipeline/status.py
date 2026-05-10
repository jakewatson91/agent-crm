"""
Pipeline status — shows where you are at any moment.

Reports per step:
  - count of inputs available
  - count of outputs produced
  - count of outputs awaiting your review (edited but feedback.py not run)
  - count of outputs that have a captured edit (already in fewshots)
  - next-action suggestion

Usage:
    python -m scripts.p2.status
"""
from __future__ import annotations

import sys
from pathlib import Path

from . import crm
from ._common import REPO_ROOT, FEWSHOTS_DIR, detect_edit, hash_text

UNDERSTAND_DIR = REPO_ROOT / "understand"
SCORE_DIR = REPO_ROOT / "score"
MATCH_DIR = REPO_ROOT / "match"
POSTS_DIR = REPO_ROOT / "posts"

STEP_DIRS = {
    "understand": UNDERSTAND_DIR,
    "score": SCORE_DIR,
    "match": MATCH_DIR,
}


def count_md(dir_path: Path) -> int:
    if not dir_path.exists():
        return 0
    return sum(1 for p in dir_path.glob("*.md")
               if not p.name.startswith("_") and not p.name.endswith(".original.md"))


def count_edited(dir_path: Path) -> int:
    """Count files where .md hash differs from .original.md (= awaiting feedback)."""
    if not dir_path.exists():
        return 0
    n = 0
    for md_path in dir_path.glob("*.md"):
        if md_path.name.startswith("_") or md_path.name.endswith(".original.md"):
            continue
        if detect_edit(dir_path, md_path.stem) is not None:
            n += 1
    return n


def count_fewshots(step: str) -> int:
    path = FEWSHOTS_DIR / f"{step}.jsonl"
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text().splitlines() if line.strip())


DASH = "─" * 70


def main() -> int:
    print()
    print(DASH)
    print("  P2 PIPELINE STATUS")
    print(DASH)

    crm.init()
    with crm.connect() as con:
        s = crm.stats(con)
        # Per-status company breakdown
        status_counts = dict(con.execute(
            "SELECT status, COUNT(*) FROM companies GROUP BY status"
        ).fetchall())
        # Score distribution
        score_buckets = con.execute("""
            SELECT
                CASE
                    WHEN intent_score >= 7 THEN 'pursue (7+)'
                    WHEN intent_score >= 5 THEN 'watch (5-6)'
                    WHEN intent_score IS NOT NULL THEN 'drop (0-4)'
                    ELSE 'unscored'
                END AS bucket,
                COUNT(DISTINCT company_id) AS n
            FROM posts
            GROUP BY bucket
        """).fetchall()

    print()
    print("  Step 1 — scrape")
    print(f"    posts in CRM:      {s['posts']}")
    print(f"    companies in CRM:  {s['companies']}")
    print(f"    posts/_inventory.md exists: {(POSTS_DIR/'_inventory.md').exists()}")

    print()
    print("  Step 2 — understand")
    n_md = count_md(UNDERSTAND_DIR)
    n_edited = count_edited(UNDERSTAND_DIR)
    n_fs = count_fewshots("understand")
    print(f"    comprehension docs:           {n_md}")
    print(f"    companies WITH understanding: {s['companies_with_understanding']}")
    print(f"    edited & awaiting feedback:   {n_edited}")
    print(f"    fewshot examples accumulated: {n_fs}")

    print()
    print("  Step 3 — score")
    n_md = count_md(SCORE_DIR)
    n_edited = count_edited(SCORE_DIR)
    n_fs = count_fewshots("score")
    print(f"    score docs:                   {n_md}")
    print(f"    edited & awaiting feedback:   {n_edited}")
    print(f"    fewshot examples accumulated: {n_fs}")
    if score_buckets:
        for r in score_buckets:
            print(f"      {r[0]:<14}  {r[1]} companies")

    print()
    print("  Step 4 — match")
    n_md = count_md(MATCH_DIR)
    n_edited = count_edited(MATCH_DIR)
    n_fs = count_fewshots("match")
    print(f"    match docs:                   {n_md}")
    print(f"    edited & awaiting feedback:   {n_edited}")
    print(f"    fewshot examples accumulated: {n_fs}")
    print(f"    matches (auto):               {s['matches_auto']}")
    print(f"    matches (user_confirmed):     {s['matches_confirmed']}")
    print(f"    matches (user_rejected):      {s['matches_rejected']}")

    print()
    print("  Companies by status")
    for st, n in sorted(status_counts.items(), key=lambda x: -(x[1] or 0)):
        print(f"    {(st or '(null)'):<12}  {n}")

    # Next-action suggestion
    print()
    print(DASH)
    print("  NEXT ACTION")
    print(DASH)

    if s['posts'] == 0:
        print("  → python -m scripts.p2.scrape")
    elif s['templates'] == 0:
        print("  → python -m scripts.p2.index_templates sim_templates.json")
    elif count_edited(UNDERSTAND_DIR) > 0:
        print(f"  → python -m scripts.p2.feedback understand   "
              f"({count_edited(UNDERSTAND_DIR)} edits awaiting capture)")
    elif s['companies_with_understanding'] < min(20, s['companies']):
        print("  → python -m scripts.p2.understand --top-n 20   "
              f"(only {s['companies_with_understanding']}/{s['companies']} comprehended)")
    elif count_edited(SCORE_DIR) > 0:
        print(f"  → python -m scripts.p2.feedback score   "
              f"({count_edited(SCORE_DIR)} edits awaiting capture)")
    elif count_md(SCORE_DIR) < s['companies_with_understanding']:
        print("  → python -m scripts.p2.score --top-n 20   "
              f"(only {count_md(SCORE_DIR)}/{s['companies_with_understanding']} scored)")
    elif count_edited(MATCH_DIR) > 0:
        print(f"  → python -m scripts.p2.feedback match   "
              f"({count_edited(MATCH_DIR)} decisions awaiting capture)")
    elif count_md(MATCH_DIR) < s['companies_with_understanding']:
        print("  → python -m scripts.p2.match --top-n 20   "
              f"(only {count_md(MATCH_DIR)}/{s['companies_with_understanding']} matched)")
    else:
        print("  Pipeline is idle.")
        print("  Try: rm understand/<id>.md && python -m scripts.p2.understand --top-n 5 --force")
        print("  to re-run with current fewshots applied.")

    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
