"""
Step 2.5 — classify each entity's decision urgency, themes, role, note hook.

This step does NOT decide whether to engage — Sim alignment (entity-level
cosine to corpus) and cumulative intent (decay-weighted post-level cosine)
already do that. This step decides the **action shape** when we do engage:
active_build → ship a Mothership prompt; philosophical → discovery note;
quiet → no outreach.

This step reads the entity's understanding_md + recent posts and produces:
  - decision_urgency: active_build | building_soon | philosophical | quiet
  - themes: list of consistent theme clusters
  - role_context: stage / role / decision-power
  - note_hook: opener for send_note action

Persists to the entity row (decision_urgency, urgency_reasoning, icp_themes,
icp_role_context, icp_note_hook, icp_md).

Usage:
    python -m scripts.p2.classify_icp                       # all entities with understanding
    python -m scripts.p2.classify_icp --entity-type lead
    python -m scripts.p2.classify_icp --entity-id keith_rabkin --entity-type lead
    python -m scripts.p2.classify_icp --force               # re-classify everything
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
from ._common import REPO_ROOT, load_env, load_prompt

DEFAULT_MODEL = "gpt-4o"
PARALLEL = 4
MAX_TOKENS = 1200
RECENT_POSTS = 10


def build_user_prompt(entity_row, entity_type: str, posts: list) -> str:
    parts = [
        f"ENTITY TYPE: {entity_type}",
        f"ENTITY NAME: {entity_row['name']}",
    ]
    if entity_type == "lead":
        parts += [
            f"  handle: {entity_row['handle'] or '(unknown)'}",
            f"  channel: {entity_row['channel'] or '(unknown)'}",
            f"  parent_account_id: {entity_row['parent_account_id'] or '(none)'}",
        ]
    else:
        parts += [f"  domain: {entity_row['domain'] or '(unknown)'}"]
    parts += [
        "",
        "UNDERSTANDING DOC:",
        entity_row["understanding_md"] or "(empty)",
        "",
        f"LAST {len(posts)} POSTS (chronological, oldest first):",
        "",
    ]
    for i, p in enumerate(posts, 1):
        parts.append(f"--- post {i} ({p['posted_at'][:10]}, {p['channel']}, intent {p['intent_score'] or 0}/10) ---")
        parts.append(f"  url: {p['url']}")
        parts.append(f"  title: {p['title']}")
        parts.append("  text:")
        parts.append((p["text"] or "")[:1500])
        parts.append("")
    return "\n".join(parts)


def render_icp_md(c: dict) -> str:
    """Render the classifier output as a single human-readable markdown block."""
    themes = c.get("themes") or []
    urgency = c.get("decision_urgency") or "?"
    lines = [
        f"# Action-shape classification",
        "",
        f"**Decision urgency:** **{urgency.upper()}**",
        "",
        "## Why this urgency",
        "",
        c.get("urgency_reasoning") or "(none)",
        "",
        "## Themes (consistent across recent posts)",
        "",
    ]
    for t in themes:
        lines.append(f"- {t}")
    if not themes:
        lines.append("(none identified)")
    lines.append("")
    lines.append("## Theme evidence")
    lines.append("")
    lines.append(c.get("theme_evidence") or "(none)")
    lines.append("")
    lines.append("## Role / stage context")
    lines.append("")
    lines.append(c.get("role_context") or "(none)")
    lines.append("")
    if c.get("note_hook"):
        lines.append("## Note hook (suggested opener for send_note action)")
        lines.append("")
        lines.append(f"> {c['note_hook']}")
        lines.append("")
    return "\n".join(lines)


async def classify_one(client: openai.AsyncOpenAI, model: str, entity_row, entity_type: str,
                        posts: list, base_prompt: str) -> dict:
    user_prompt = build_user_prompt(entity_row, entity_type, posts)
    try:
        r = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": base_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=MAX_TOKENS,
        )
    except openai.APIError as e:
        return {"error": f"{type(e).__name__}: {e}"}
    raw = r.choices[0].message.content or ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": "json parse failed", "raw": raw[:1000]}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entity-type", choices=["account", "lead"], default=None)
    parser.add_argument("--entity-id", default=None)
    parser.add_argument("--force", action="store_true",
                        help="re-classify even if decision_urgency already set")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set")
        return 2

    base_prompt = load_prompt("classify_icp")
    crm.init()

    targets: list[tuple[dict, str, list]] = []
    types = [args.entity_type] if args.entity_type else ["lead", "account"]
    with crm.connect() as con:
        for et in types:
            id_col = "account_id" if et == "account" else "lead_id"
            table = "accounts" if et == "account" else "leads"
            sql = (f"SELECT * FROM {table} WHERE understanding_md IS NOT NULL "
                   f"AND understanding_md != '' "
                   f"AND (status IS NULL OR status != 'dropped')")
            params: list = []
            if args.entity_id:
                sql += f" AND {id_col} = ?"
                params.append(args.entity_id)
            if not args.force:
                sql += " AND (decision_urgency IS NULL OR decision_urgency = '')"
            for row in con.execute(sql, params).fetchall():
                eid = row[id_col]
                posts = con.execute(
                    f"SELECT * FROM posts WHERE {id_col}=? ORDER BY posted_at ASC LIMIT ?",
                    (eid, RECENT_POSTS),
                ).fetchall()
                targets.append((dict(row), et, [dict(p) for p in posts]))

    if not targets:
        print("[classify_icp] nothing to classify (use --force to redo)")
        return 0

    print(f"[classify_icp] {len(targets)} entities, model={args.model}")
    client = openai.AsyncOpenAI()
    sem = asyncio.Semaphore(PARALLEL)

    async def _runner(entity, entity_type, posts):
        async with sem:
            classification = await classify_one(client, args.model, entity, entity_type, posts, base_prompt)
            return entity, entity_type, classification

    started = time.time()
    results = await asyncio.gather(*(_runner(e, t, p) for e, t, p in targets))
    await client.close()

    with crm.connect() as con:
        for entity, entity_type, c in results:
            id_col = "account_id" if entity_type == "account" else "lead_id"
            table = "accounts" if entity_type == "account" else "leads"
            eid = entity[id_col]
            if "error" in c:
                print(f"  ✗  {entity_type}:{eid}: {c['error']}")
                continue
            md = render_icp_md(c)
            con.execute(
                f"UPDATE {table} SET icp_themes=?, icp_role_context=?, "
                f"icp_note_hook=?, icp_md=?, decision_urgency=?, urgency_reasoning=? "
                f"WHERE {id_col}=?",
                (
                    json.dumps(c.get("themes") or []),
                    c.get("role_context") or "",
                    c.get("note_hook") or "",
                    md,
                    c.get("decision_urgency") or "",
                    c.get("urgency_reasoning") or "",
                    eid,
                ),
            )
            print(f"  ✓  {entity_type:<7} {eid:<22} "
                  f"urgency={c.get('decision_urgency','?'):<16} "
                  f"themes={len(c.get('themes') or [])}")
        active = sum(1 for _,_,c in results if c.get('decision_urgency')=='active_build')
        crm.log_decision(con, action="classify_icp",
                          summary=f"classified {len(results)} entities; {active} active_build")
        con.commit()

    elapsed = time.time() - started
    print()
    print(f"[classify_icp] done in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
