"""
Bulk-load sim_templates.json into the CRM templates table.

Input format (sim_templates.json):
[
  {"workflow_name": "...", "category": "...", "inferred_purpose": "..."},
  ...
]

Each template gets:
- template_id: slug derived from workflow_name (stable, idempotent)
- embedding: BAAI/bge-small-en-v1.5 of "workflow_name. category. inferred_purpose"

Re-running replaces existing rows (so editing the JSON and re-loading works).

Usage:
    python -m scripts.p2.index_templates sim_templates.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from . import crm

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def slug_from_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="sim_templates.json")
    args = parser.parse_args()

    if not args.path.exists():
        print(f"ERROR: file not found: {args.path}")
        return 2

    raw = json.loads(args.path.read_text())
    if not isinstance(raw, list):
        print(f"ERROR: expected a JSON array of templates, got {type(raw).__name__}")
        return 2

    # Build text representations for embedding
    records: list[dict] = []
    texts: list[str] = []
    seen_ids: set[str] = set()
    for r in raw:
        if not isinstance(r, dict):
            continue
        name = (r.get("workflow_name") or r.get("name") or "").strip()
        if not name:
            continue
        category = (r.get("category") or "").strip()
        purpose = (r.get("inferred_purpose") or r.get("description") or "").strip()
        tid = slug_from_name(name)
        # Disambiguate duplicate slugs
        i = 2
        while tid in seen_ids:
            tid = f"{slug_from_name(name)}_{i}"
            i += 1
        seen_ids.add(tid)
        embed_text = f"{name}. {category}. {purpose}"
        records.append({
            "template_id": tid,
            "name": name,
            "category": category,
            "description": purpose,
            "embed_text": embed_text,
            "tags": [category] if category else [],
        })
        texts.append(embed_text)

    if not records:
        print("ERROR: no usable template records")
        return 2

    print(f"[index_templates] embedding {len(records)} templates...")
    embeddings = crm.embed_many(texts)

    crm.init()
    with crm.connect() as con:
        for rec, emb in zip(records, embeddings):
            crm.upsert_template(
                con,
                template_id=rec["template_id"],
                name=rec["name"],
                category=rec["category"],
                description=rec["description"],
                tags=rec["tags"],
                embedding=emb,
            )
        con.commit()
        n = con.execute("SELECT COUNT(*) FROM templates").fetchone()[0]

    print(f"[index_templates] templates table now has {n} rows")
    # Show category breakdown
    with crm.connect() as con:
        rows = con.execute(
            "SELECT category, COUNT(*) FROM templates GROUP BY category ORDER BY 2 DESC"
        ).fetchall()
        for r in rows:
            print(f"  {r[0] or '(no category)':<28} {r[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
