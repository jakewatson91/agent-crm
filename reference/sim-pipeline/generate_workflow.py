"""
Generate a Mothership prompt for one prospect.

Outreach is always addressed to a LEAD (a person), never to an account abstractly.
But the SIGNAL feeding the prompt can be account-level (news, jobs) plus lead-level
(personal posts). When invoked with --account-id, we resolve to the top lead at
that account and combine both context streams.

Reads:
  - leads.understanding_md (always)
  - accounts.understanding_md (when account-id passed OR lead has parent account)
  - matches table for the lead AND account (unified corpus candidates from both)
  - posts attached to the lead AND the account (account posts are news/jobs)

Output:
  - golden/<lead_id>/mothership_prompt.md  (paste-ready, addressed to the lead)
  - golden/<lead_id>/mothership_prompt.input.md  (audit: full LLM prompt)
  - golden/<lead_id>/mothership_prompt.output.json (audit: model metadata)

Usage:
    python -m scripts.p2.generate_workflow --lead-id keith_rabkin
    python -m scripts.p2.generate_workflow --account-id pandadoc.com   # → routes to top lead
    python -m scripts.p2.generate_workflow --all-leads
    python -m scripts.p2.generate_workflow --all-accounts              # → routes each to top lead
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

from . import crm, experiments
from ._common import REPO_ROOT, load_env, load_prompt

GOLDEN_DIR = REPO_ROOT / "golden"
DEFAULT_MODEL = "gpt-4o"
MAX_TOKENS = 3500
TOP_K_CORPUS = 12
TOP_POSTS = 8


def build_user_prompt(
    *,
    lead_row,
    account_row,
    posts: list,
    candidates: list[dict],
) -> str:
    parts = [
        "PROSPECT",
        f"  lead_id: {lead_row['lead_id']}",
        f"  name: {lead_row['name']}",
        f"  handle: {lead_row['handle'] or '(unknown)'}",
        f"  channel: {lead_row['channel'] or '(unknown)'}",
    ]
    if account_row:
        parts += [
            f"  parent_account: {account_row['name']} ({account_row['domain']})",
        ]
    parts += [
        "",
        "UNDERSTANDING DOC (the comprehension we built from their public posts):",
        lead_row["understanding_md"] or "(empty)",
        "",
        "ACCOUNT UNDERSTANDING DOC (their company, if available):",
        (account_row["understanding_md"] if account_row and account_row["understanding_md"] else "(none)"),
        "",
        f"TOP {len(posts)} POSTS (highest-intent first, with verbatim text):",
        "",
    ]
    for i, p in enumerate(posts, 1):
        parts.append(f"--- post {i} (intent_score: {p['intent_score'] or 0}/10, channel: {p['channel']}) ---")
        parts.append(f"  url: {p['url']}")
        parts.append(f"  posted_at: {p['posted_at']}")
        parts.append("  text:")
        parts.append((p["text"] or "")[:1500])
        parts.append("")

    parts += [
        f"MATCHED SIM CORPUS CANDIDATES (top {len(candidates)} by cosine — pick from these for primitive references):",
        "",
    ]
    for i, c in enumerate(candidates, 1):
        parts.append(f"--- candidate {i} ---")
        parts.append(f"  kind: {c['kind']}")
        parts.append(f"  id: {c['id']}")
        parts.append(f"  name: {c['name']}")
        parts.append(f"  cosine: {c['cosine_score']:.3f}")
        parts.append(f"  excerpt: {c['description'][:300]}")
        parts.append("")
    return "\n".join(parts)


async def generate_one(client: openai.AsyncOpenAI, model: str, lead_id: str) -> dict:
    crm.init()
    with crm.connect() as con:
        lead = con.execute("SELECT * FROM leads WHERE lead_id=?", (lead_id,)).fetchone()
        if not lead:
            return {"error": f"lead_id={lead_id} not found"}
        account = None
        if lead["parent_account_id"]:
            account = con.execute(
                "SELECT * FROM accounts WHERE account_id=?", (lead["parent_account_id"],)
            ).fetchone()
        posts = con.execute(
            "SELECT * FROM posts WHERE lead_id=? ORDER BY COALESCE(intent_score,0) DESC, posted_at DESC LIMIT ?",
            (lead_id, TOP_POSTS),
        ).fetchall()
        candidates = crm.cosine_match_entity_to_corpus(
            con, "lead", lead_id, top_k=TOP_K_CORPUS, min_cosine=0.50
        )

    if not lead["understanding_md"]:
        return {"error": f"lead {lead_id} has no understanding_md — run understand first"}
    if not posts:
        return {"error": f"lead {lead_id} has no posts attached"}
    if not candidates:
        return {"error": f"no corpus candidates above min_cosine for {lead_id} — run match first"}

    base_prompt = load_prompt("generate_workflow")

    # EXPERIMENT: prompt_composition — Thompson-sample whether to compose with
    # anchor-only or anchor+breadth. Outcome (fork-click) recorded post-send.
    composition_arm = experiments.sample("prompt_composition") or "anchor_plus_breadth"
    if composition_arm == "anchor_only":
        base_prompt += (
            "\n\n## EXPERIMENT OVERRIDE — anchor_only mode\n"
            "For this run: build the workflow purely from the SINGLE highest-scoring "
            "post. Do NOT compose breadth across multiple posts. The flow scaffolds "
            "exactly the system from that one post."
        )

    user_prompt = build_user_prompt(
        lead_row=lead, account_row=account,
        posts=[dict(p) for p in posts], candidates=candidates,
    )

    full_input = f"=== SYSTEM ===\n{base_prompt}\n\n=== USER ===\n{user_prompt}"

    started = time.time()
    try:
        r = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": base_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=MAX_TOKENS,
        )
    except openai.APIError as e:
        return {"error": f"{type(e).__name__}: {e}", "input": full_input}
    elapsed = time.time() - started

    content = (r.choices[0].message.content or "").strip()
    # Strip code fences if the model wrapped the output
    if content.startswith("```"):
        first_nl = content.find("\n")
        if first_nl != -1:
            content = content[first_nl + 1:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

    return {
        "lead_id": lead_id,
        "lead_name": lead["name"],
        "model": model,
        "elapsed_seconds": round(elapsed, 1),
        "input_tokens": r.usage.prompt_tokens if r.usage else None,
        "output_tokens": r.usage.completion_tokens if r.usage else None,
        "n_candidates_fed": len(candidates),
        "n_posts_fed": len(posts),
        "experiment_prompt_composition_arm": composition_arm,
        "mothership_prompt": content,
        "full_input": full_input,
    }


def write_outputs(lead_id: str, result: dict) -> Path:
    out_dir = GOLDEN_DIR / lead_id
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / "mothership_prompt.md"
    if "error" in result:
        md_path.write_text(f"# generation failed\n\nERROR: {result['error']}\n")
    else:
        md_path.write_text(result["mothership_prompt"])
    if result.get("full_input"):
        (out_dir / "mothership_prompt.input.md").write_text(result["full_input"])
    audit = {k: v for k, v in result.items() if k not in ("mothership_prompt", "full_input")}
    (out_dir / "mothership_prompt.output.json").write_text(json.dumps(audit, indent=2))
    return md_path


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lead-id", action="append", default=[],
                        help="lead_id to generate for (repeatable)")
    parser.add_argument("--all-leads", action="store_true",
                        help="generate for every lead with understanding_md")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set")
        return 2

    crm.init()
    if args.all_leads:
        with crm.connect() as con:
            rows = con.execute(
                "SELECT lead_id FROM leads WHERE understanding_md IS NOT NULL AND understanding_md != ''"
            ).fetchall()
            lead_ids = [r["lead_id"] for r in rows]
    else:
        lead_ids = args.lead_id

    if not lead_ids:
        print("ERROR: pass --lead-id <id> (repeatable) or --all-leads")
        return 2

    print(f"[generate_workflow] {len(lead_ids)} leads, model={args.model}")
    client = openai.AsyncOpenAI()
    results = await asyncio.gather(*(generate_one(client, args.model, lid) for lid in lead_ids))
    await client.close()

    with crm.connect() as con:
        for lead_id, result in zip(lead_ids, results):
            path = write_outputs(lead_id, result)
            if "error" in result:
                print(f"  ✗  {lead_id}: {result['error']}")
                continue
            print(f"  ✓  {lead_id}: {path.relative_to(REPO_ROOT)} "
                  f"({len(result['mothership_prompt'])} chars, "
                  f"{result['elapsed_seconds']}s, "
                  f"{result['input_tokens']}→{result['output_tokens']} tokens)")
            crm.log_decision(con, action="generate_workflow",
                              summary=f"Mothership prompt for {result['lead_name']} ({result['n_candidates_fed']} candidates fed)",
                              entity_type="lead", entity_id=lead_id,
                              metadata={"model": args.model,
                                        "n_candidates": result["n_candidates_fed"]})
        con.commit()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
