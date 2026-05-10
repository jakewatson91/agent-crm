"""
Step 3 — unified retrieval + LLM decision per entity.

For each entity (account or lead) with a non-null embedding:
  - Cosine-match against the unified Sim corpus (82 templates + 3839 doc chunks)
  - Take top-K above MIN_COSINE
  - Pass the unified ranked list to the LLM
  - LLM picks ONE of four actions:
      ship_template               — top-1 template is a clean fit, ship it as-is
      custom_workflow_with_template — extend a near-fit template with primitives
      full_custom_workflow        — no template fits; compose primitives from doc chunks
      just_a_note                 — nothing strong enough; outreach is just contextual

Persisted to:
  - matches table — one row per (entity, top-1 candidate) regardless of kind
  - match/<entity_slug>.md — full ranked list + decision rationale
  - match/_inbox.md — aggregate triage view

Usage:
    python -m scripts.p2.match
    python -m scripts.p2.match --entity-id keith_rabkin --entity-type lead
    python -m scripts.p2.match --no-llm
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

MATCH_DIR = REPO_ROOT / "match"
INBOX_PATH = MATCH_DIR / "_inbox.md"
DEFAULT_MODEL = "gpt-4o-mini"
PARALLEL = 6
DEFAULT_MIN_COSINE = 0.50
TOP_K = 15

# Default thresholds for the decision tree (the LLM is allowed to override
# but these are the canonical guardrails we want the prompt to respect).
SHIP_TEMPLATE_THRESHOLD = 0.70    # top-1 must be a TEMPLATE at >= this for ship_template
CUSTOM_WITH_TEMPLATE_MIN = 0.60   # template-near-fit + relevant docs
CUSTOM_DOC_MIN = 0.62             # at least one doc above this for full_custom_workflow
NOTE_FALLBACK_THRESHOLD = 0.55    # if top-1 below this → just_a_note


def _slug(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}__{entity_id}"


def build_match_input(entity_row, entity_type: str, candidates: list[dict]) -> str:
    parts = [
        f"ENTITY TYPE: {entity_type}",
        f"ENTITY NAME: {entity_row['name']}",
        "",
        "UNDERSTANDING DOC:",
        entity_row["understanding_md"] or "(empty)",
        "",
        f"UNIFIED RANKED CORPUS (top {len(candidates)}, mixed templates + sim docs, "
        f"sorted by cosine desc):",
        "",
    ]
    for i, c in enumerate(candidates, 1):
        parts.append(f"--- candidate {i} ---")
        parts.append(f"  kind: {c['kind']}")
        parts.append(f"  id: {c['id']}")
        parts.append(f"  name: {c['name']}")
        parts.append(f"  category/source: {c['category']}")
        parts.append(f"  cosine: {c['cosine_score']:.3f}")
        parts.append(f"  excerpt: {c['description'][:250]}")
        parts.append("")
    parts += [
        "DECISION GUARDRAILS (you may override with explicit reasoning):",
        f"  - ship_template:  top-1 is a TEMPLATE with cosine >= {SHIP_TEMPLATE_THRESHOLD} AND fit=good",
        f"  - custom_workflow_with_template:  a template at >= {CUSTOM_WITH_TEMPLATE_MIN} that needs adaptation, "
        f"plus relevant doc primitives in the list",
        f"  - full_custom_workflow:  no template fits, but >=2 doc chunks at >= {CUSTOM_DOC_MIN}",
        f"  - just_a_note:  nothing above {NOTE_FALLBACK_THRESHOLD}, OR top hits are off-topic — "
        f"send a contextual reply only, no shipping artifact",
    ]
    return "\n".join(parts)


async def reason_one(client: openai.AsyncOpenAI, model: str, entity_row, entity_type: str,
                     candidates: list[dict],
                     base_prompt: str, fewshots: list) -> tuple[dict, str, str]:
    """Returns (parsed_reasoning_dict, full_user_prompt, raw_response_text).
    The latter two are for audit log persistence.
    """
    user_prompt = build_match_input(entity_row, entity_type, candidates)
    sys_prompt = base_prompt
    fewshot_block = format_fewshots_block(fewshots)
    if fewshot_block:
        sys_prompt = base_prompt + "\n\n" + fewshot_block
    full_input = f"=== SYSTEM ===\n{sys_prompt}\n\n=== USER ===\n{user_prompt}"
    try:
        r = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=900,
        )
    except openai.APIError as e:
        return ({"error": f"{type(e).__name__}: {e}"}, full_input, "")
    raw = r.choices[0].message.content or ""
    try:
        return (json.loads(raw), full_input, raw)
    except json.JSONDecodeError:
        return ({"error": "json parse failed", "raw": raw[:1000]}, full_input, raw)


def render_entity_match_md(entity_type: str, entity_row, candidates: list[dict],
                            reasoning: dict) -> str:
    id_col = "account_id" if entity_type == "account" else "lead_id"
    eid = entity_row[id_col]

    confidence = reasoning.get("confidence") or "low"
    quoted_signal = reasoning.get("quoted_signal") or ""
    pitched_capabilities = reasoning.get("pitched_capabilities") or []
    pitch_subject = reasoning.get("pitch_subject") or ""
    pitch_body = reasoning.get("pitch_body") or ""
    rationale_for_us = reasoning.get("rationale_for_us") or ""
    candidate_slugs = reasoning.get("candidate_slugs_referenced") or []

    lines = [
        f"# Sales pitch: {entity_row['name']} ({entity_type})",
        "",
        f"**{id_col}:** `{eid}`",
        f"**Last matched:** {datetime.now(timezone.utc).isoformat()}",
        f"**Confidence:** {confidence}",
        "",
        "## Pitched Sim capabilities",
        "",
        ", ".join(f"`{c}`" for c in pitched_capabilities) or "(none)",
        "",
        "## Verbatim signal we're anchoring on",
        "",
        f"> {quoted_signal}" if quoted_signal else "(none — confidence should be low)",
        "",
        "## The pitch",
        "",
        f"**Subject / opener:** {pitch_subject}",
        "",
        pitch_body or "(empty)",
        "",
        "## Internal rationale (not sent)",
        "",
        rationale_for_us or "(none)",
        "",
        "## Sim corpus references used",
        "",
    ]
    if candidate_slugs:
        for s in candidate_slugs:
            lines.append(f"- `{s}`")
    else:
        lines.append("(none)")
    lines.append("")

    # Unified ranked list (all candidates regardless of kind)
    lines.append("## Unified ranked candidates (cosine across templates + Sim docs)")
    lines.append("")
    lines.append("| Cosine | Kind     | ID/Slug                         | Name                          |")
    lines.append("|--------|----------|---------------------------------|-------------------------------|")
    for c in candidates:
        lines.append(
            f"| {c['cosine_score']:.3f}  | {c['kind']:<8} | "
            f"{c['id'][:31]:<31} | {c['name'][:29]:<29} |"
        )
    lines.append("")

    lines.append("## Your decision")
    lines.append("")
    lines.append("Replace the line below with one of:")
    lines.append("- `confirm` — accept the recommended action above")
    lines.append("- `reject` — drop this entity from outbound")
    lines.append("- `override: <action>` — pick a different action (one of: ship_template, "
                 "custom_workflow_with_template, full_custom_workflow, just_a_note)")
    lines.append("")
    lines.append("**Decision:** confirm")
    lines.append("")
    lines.append("## Drop this row")
    lines.append("no")
    lines.append("")
    return "\n".join(lines)


def render_inbox(rows: list[dict]) -> str:
    rows = sorted(rows, key=lambda r: -r["top_score"])
    lines = [
        "# Pitch inbox",
        "",
        f"_{len(rows)} prospects ready to pitch. Open match/<entity_slug>.md for the full pitch._",
        "",
        "| type    | name                       | top cosine | conf   | pitched capabilities                    |",
        "|---------|----------------------------|------------|--------|-----------------------------------------|",
    ]
    for r in rows:
        caps = ", ".join((r.get("capabilities") or [])[:3])
        lines.append(
            f"| {r['entity_type']:<7} | {r['name'][:26]:<26} | {r['top_score']:>10.3f} | "
            f"{r.get('confidence','—'):<6} | {caps[:39]:<39} |"
        )
    lines.append("")
    return "\n".join(lines)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entity-type", choices=["account", "lead"], default=None)
    parser.add_argument("--entity-id", default=None)
    parser.add_argument("--min-cosine", type=float, default=DEFAULT_MIN_COSINE)
    parser.add_argument("--top-k", type=int, default=TOP_K)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--no-llm", action="store_true")
    args = parser.parse_args()

    load_env()
    crm.init()

    # Collect target entities
    entities: list[tuple[dict, str]] = []
    types = [args.entity_type] if args.entity_type else ["account", "lead"]
    with crm.connect() as con:
        for et in types:
            id_col = "account_id" if et == "account" else "lead_id"
            table = "accounts" if et == "account" else "leads"
            sql = (f"SELECT * FROM {table} WHERE embedding IS NOT NULL "
                   f"AND (status IS NULL OR status != 'dropped')")
            params: list = []
            if args.entity_id:
                sql += f" AND {id_col} = ?"
                params.append(args.entity_id)
            sql += " ORDER BY last_updated DESC"
            for row in con.execute(sql, params).fetchall():
                entities.append((dict(row), et))

    if not entities:
        print("[match] no entities with embeddings — run understand first")
        return 1

    # Unified retrieval per entity
    print(f"[match] retrieving unified corpus (templates + sim_docs) for {len(entities)} entities...")
    per_entity_candidates: dict[tuple[str, str], list[dict]] = {}
    with crm.connect() as con:
        for entity, et in entities:
            id_col = "account_id" if et == "account" else "lead_id"
            eid = entity[id_col]
            cands = crm.cosine_match_entity_to_corpus(
                con, et, eid,
                top_k=args.top_k, min_cosine=args.min_cosine,
            )
            per_entity_candidates[(et, eid)] = cands

            # sim_alignment_score = mean of top-5 cosines.
            # This is the "broad alignment" signal: how Sim-shaped is this
            # entity OVERALL? (vs top-1 cosine which only captures peak
            # alignment with one specific Sim asset.)
            top5 = cands[:5]
            alignment = (sum(c["cosine_score"] for c in top5) / len(top5)) if top5 else 0.0
            table = "accounts" if et == "account" else "leads"
            con.execute(
                f"UPDATE {table} SET sim_alignment_score=? WHERE {id_col}=?",
                (round(alignment, 3), eid),
            )
            # Persist top template hits to the matches table for backwards compat
            for c in cands:
                if c["kind"] == "template":
                    crm.upsert_match(
                        con,
                        entity_type=et, entity_id=eid,
                        template_id=c["id"],
                        cosine_score=c["cosine_score"],
                        status="auto",
                    )
        con.commit()

    # LLM reasoning
    if args.no_llm or not os.getenv("OPENAI_API_KEY"):
        if not os.getenv("OPENAI_API_KEY") and not args.no_llm:
            print("WARNING: OPENAI_API_KEY missing — skipping reasoning")
        results = []
        for entity, et in entities:
            id_col = "account_id" if et == "account" else "lead_id"
            eid = entity[id_col]
            results.append((entity, et,
                            per_entity_candidates.get((et, eid), []),
                            {}, "", ""))
    else:
        base_prompt = load_prompt("match")
        fewshots = load_fewshots("match", max_examples=5)
        if fewshots:
            print(f"[match] using {len(fewshots)} fewshot example(s)")
        client = openai.AsyncOpenAI()
        sem = asyncio.Semaphore(PARALLEL)

        async def _runner(entity, et):
            async with sem:
                id_col = "account_id" if et == "account" else "lead_id"
                eid = entity[id_col]
                cands = per_entity_candidates.get((et, eid), [])
                if not cands:
                    return (entity, et, [],
                            {"recommended_action": "just_a_note",
                             "rationale": "No candidates above min_cosine."},
                            "", "")
                reasoning, full_input, raw_output = await reason_one(
                    client, args.model, entity, et, cands,
                    base_prompt, fewshots,
                )
                return entity, et, cands, reasoning, full_input, raw_output

        results = await asyncio.gather(*(_runner(e, t) for e, t in entities))
        await client.close()

    # Write outputs + inbox
    MATCH_DIR.mkdir(parents=True, exist_ok=True)
    inbox_rows: list[dict] = []
    with crm.connect() as con:
        for entity, et, cands, reasoning, full_input, raw_output in results:
            id_col = "account_id" if et == "account" else "lead_id"
            eid = entity[id_col]
            slug = _slug(et, eid)
            md = render_entity_match_md(et, entity, cands, reasoning)
            write_md_with_original(MATCH_DIR, slug, md, force=True)

            # Audit logs: full input that fed the LLM + raw JSON it returned.
            # Lets the user trace 'why did the model say X' end-to-end.
            if full_input:
                (MATCH_DIR / f"{slug}.input.md").write_text(full_input)
            if raw_output:
                (MATCH_DIR / f"{slug}.output.json").write_text(raw_output)

            # Inbox row
            top_kind = cands[0]["kind"] if cands else "—"
            top_score = cands[0]["cosine_score"] if cands else 0.0
            inbox_rows.append({
                "entity_type": et, "entity_id": eid, "name": entity["name"],
                "top_kind": top_kind, "top_score": top_score,
                "confidence": reasoning.get("confidence") or "low",
                "capabilities": reasoning.get("pitched_capabilities") or [],
            })

        crm.log_decision(con, action="match",
                          summary=f"pitched {len(inbox_rows)} prospects; "
                                  f"confidence: " + ", ".join(
                                      r['confidence'] for r in inbox_rows))
        con.commit()

    INBOX_PATH.write_text(render_inbox(inbox_rows))
    print()
    print(f"[match] {len(inbox_rows)} prospects pitched")
    by_conf: dict[str, int] = {}
    for r in inbox_rows:
        c = r.get("confidence", "low")
        by_conf[c] = by_conf.get(c, 0) + 1
    for c, n in sorted(by_conf.items(), key=lambda x: -x[1]):
        print(f"  confidence={c}: {n}")
    print(f"  inbox: {INBOX_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
