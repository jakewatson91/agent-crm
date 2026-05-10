"""
Step 1 — comprehend each entity (account or lead) in the CRM.

For each entity that has post evidence and no understanding doc (or --force),
gather attached posts, call the LLM with prompts/understand.md + fewshots, and
write understand/<entity_type>__<entity_id>.md.

Updates the entity row's `understanding_md` and recomputes `embedding`.

Usage:
    python -m scripts.p2.understand                         # all entities
    python -m scripts.p2.understand --entity-type lead      # only leads
    python -m scripts.p2.understand --entity-type account   # only accounts
    python -m scripts.p2.understand --entity-id emir_atli
    python -m scripts.p2.understand --force                 # re-comprehend all
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import openai

from . import crm
from ._common import (
    REPO_ROOT, load_env, load_prompt, load_fewshots,
    format_fewshots_block, write_md_with_original,
)

UNDERSTAND_DIR = REPO_ROOT / "understand"
DEFAULT_MODEL = "gpt-4o"
PARALLEL = 4
MAX_TOKENS = 1500


def _slug(entity_type: str, entity_id: str) -> str:
    """Filesystem slug — keeps lead and account namespaces separate."""
    return f"{entity_type}__{entity_id}"


def build_evidence(entity_row, entity_type: str, posts) -> str:
    name = entity_row["name"]
    if entity_type == "account":
        head = [
            f"ENTITY TYPE: account (company)",
            f"  name: {name}",
            f"  domain: {entity_row['domain'] or '(unknown)'}",
            "",
        ]
    else:
        head = [
            f"ENTITY TYPE: lead (person)",
            f"  name: {name}",
            f"  handle: {entity_row['handle'] or '(unknown)'}",
            f"  channel: {entity_row['channel'] or '(unknown)'}",
            f"  parent_account_id: {entity_row['parent_account_id'] or '(none)'}",
            "",
        ]
    head += [f"POST EVIDENCE ({len(posts)} attached):", ""]

    for i, p in enumerate(posts, 1):
        head.append(f"--- post {i} ---")
        head.append(f"channel: {p['channel']}")
        head.append(f"url: {p['url']}")
        head.append(f"author_handle: {p['author_handle']}")
        head.append(f"posted_at: {p['posted_at']}")
        head.append(f"title: {p['title']}")
        head.append("text:")
        head.append((p["text"] or "")[:2500])
        head.append("")
    return "\n".join(head)


async def comprehend_one(
    client: openai.AsyncOpenAI,
    model: str,
    entity_row,
    entity_type: str,
    posts,
    fewshots: list,
    base_prompt: str,
) -> str:
    evidence = build_evidence(entity_row, entity_type, posts)
    fewshot_block = format_fewshots_block(fewshots)
    sys_prompt = base_prompt + ("\n\n" + fewshot_block if fewshot_block else "")

    try:
        r = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": evidence},
            ],
            max_completion_tokens=MAX_TOKENS,
        )
    except openai.APIError as e:
        return f"# Understanding failed\n\nERROR: {type(e).__name__}: {e}\n"
    content = (r.choices[0].message.content or "").strip()
    if content.startswith("```"):
        first_nl = content.find("\n")
        if first_nl != -1:
            content = content[first_nl + 1:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()
    return content


def _entity_id_field(entity_type: str) -> str:
    return "account_id" if entity_type == "account" else "lead_id"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entity-type", choices=["account", "lead"], default=None,
                        help="restrict to one entity type")
    parser.add_argument("--entity-id", default=None,
                        help="comprehend a specific entity_id (requires --entity-type)")
    parser.add_argument("--force", action="store_true",
                        help="overwrite existing understanding")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set")
        return 2

    base_prompt = load_prompt("understand")
    fewshots = load_fewshots("understand", max_examples=5)
    if fewshots:
        print(f"[understand] using {len(fewshots)} fewshot example(s)")

    crm.init()

    # Build target list
    targets: list[tuple[dict, str, list[dict]]] = []
    entity_types = [args.entity_type] if args.entity_type else ["account", "lead"]

    with crm.connect() as con:
        for et in entity_types:
            id_col = _entity_id_field(et)
            table = "accounts" if et == "account" else "leads"
            sql = f"""
                SELECT e.*, COUNT(p.post_id) AS post_count
                FROM {table} e
                LEFT JOIN posts p ON p.{id_col} = e.{id_col}
                WHERE (e.status IS NULL OR e.status != 'dropped')
            """
            params: list = []
            if args.entity_id:
                sql += f" AND e.{id_col} = ?"
                params.append(args.entity_id)
            sql += f" GROUP BY e.{id_col} HAVING post_count > 0 ORDER BY post_count DESC"
            rows = con.execute(sql, params).fetchall()

            for row in rows:
                eid = row[id_col]
                slug = _slug(et, eid)
                if (UNDERSTAND_DIR / f"{slug}.md").exists() and not args.force:
                    continue
                posts = crm.fetch_posts_for_entity(con, et, eid, limit=20)
                if not posts:
                    continue
                targets.append((dict(row), et, [dict(p) for p in posts]))

    if not targets:
        print("[understand] nothing to do (use --force to redo)")
        return 0

    print(f"[understand] comprehending {len(targets)} entities, model={args.model}")
    client = openai.AsyncOpenAI()
    sem = asyncio.Semaphore(PARALLEL)

    async def _runner(entity, entity_type, posts):
        async with sem:
            md = await comprehend_one(client, args.model, entity, entity_type, posts,
                                       fewshots, base_prompt)
            return entity, entity_type, md

    started = time.time()
    results = await asyncio.gather(*(_runner(e, t, p) for e, t, p in targets))

    written = 0
    with crm.connect() as con:
        for entity, entity_type, md in results:
            id_col = _entity_id_field(entity_type)
            eid = entity[id_col]
            slug = _slug(entity_type, eid)
            write_md_with_original(UNDERSTAND_DIR, slug, md, force=args.force)
            crm.update_entity_understanding(con, entity_type, eid, md)
            crm.log_decision(con, action="understand",
                              summary=f"comprehended {entity_type} {eid} ({len(md)} chars)",
                              entity_type=entity_type, entity_id=eid)
            written += 1
            print(f"  wrote understand/{slug}.md  ({len(md)} chars)")
        con.commit()

    print()
    print(f"[understand] {written} comprehension docs in {time.time()-started:.1f}s")
    print(f"  review: ls understand/")
    print(f"  edit any .md that's wrong, then: python -m scripts.p2.feedback understand")

    await client.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
