"""
Step 2 — score each post 0-10 on Sim alignment.

The score is DETERMINISTIC from the post's embedding cosine to Sim's corpus.
No LLM judgment of the score itself. The LLM is still called per post to
generate a written rationale (explanatory audit blob: signal quote, inferred
problem, narrative), but the numeric intent_score = mean of top-5 cosines
between the post embedding and Sim corpus chunks, calibrated 0-10.

Cumulative score uses time-decayed weights over the score:
    cum = sum( intent_score * exp(-days_since_post / 7) )
    over posts in the last 14 days.

Usage:
    python -m scripts.p2.score                    # score all unscored posts
    python -m scripts.p2.score --force            # rescore everything
    python -m scripts.p2.score --post-id <id>     # score a single post
    python -m scripts.p2.score --emit-cards       # also write score/<slug>.md
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
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

SCORE_DIR = REPO_ROOT / "score"
RANKED_PATH = SCORE_DIR / "_ranked.md"
DEFAULT_MODEL = "gpt-4o-mini"
PARALLEL = 6
MAX_TOKENS = 700


def _slug(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}__{entity_id}"


# ---------------------------------------------------------------------------
# Per-post scoring

def build_post_input(post_row, parent_understanding: str = "",
                     corpus_matches: list[dict] | None = None) -> str:
    parts = []
    if parent_understanding:
        parts.append("PARENT ENTITY UNDERSTANDING:")
        parts.append(parent_understanding[:1500])
        parts.append("")
    parts.append(f"POST")
    parts.append(f"  channel: {post_row['channel']}")
    parts.append(f"  url: {post_row['url']}")
    parts.append(f"  posted_at: {post_row['posted_at']}")
    parts.append(f"  author_handle: {post_row['author_handle']}")
    parts.append(f"  title: {post_row['title']}")
    parts.append("  text:")
    parts.append((post_row["text"] or "")[:2200])

    # If the post has been embedded, include its top semantic matches against
    # the Sim corpus. This GROUNDS the LLM's score in actual Sim positioning
    # rather than the LLM's general training knowledge of B2B sales.
    if corpus_matches:
        parts.append("")
        parts.append("TOP SIM CORPUS MATCHES FOR THIS POST (cosine on post embedding):")
        parts.append("These are the Sim primitives/blog posts/templates this specific post is")
        parts.append("semantically closest to. Use them to calibrate your score: a post that's")
        parts.append("strongly aligned with multiple Sim primitives is a stronger buying-intent")
        parts.append("signal than a post that's only weakly aligned with the corpus.")
        parts.append("")
        for i, m in enumerate(corpus_matches[:3], 1):
            parts.append(f"  {i}. [{m['kind']}] {m['name']} (cosine {m['cosine_score']:.3f})")
            parts.append(f"     {m['description'][:200]}")
            parts.append("")
    return "\n".join(parts)


def cosine_intent_score(corpus_matches: list[dict] | None) -> int:
    """Deterministic 0-10 intent score from per-post cosine to Sim corpus.

    Uses mean of top-5 cosines, mapped from [0.50, 0.85] → [0, 10] with clamp.
    Empirically: relevant agentic-build posts land 0.65-0.80; off-topic posts
    are filtered to <0.50 by min_cosine in cosine_match_post_to_corpus.
    """
    if not corpus_matches:
        return 0
    top = corpus_matches[:5]
    mean_cos = sum(m["cosine_score"] for m in top) / len(top)
    scaled = round((mean_cos - 0.50) / 0.035)
    return max(0, min(10, scaled))


def parse_score_from_md(md: str) -> tuple[str, str, str, str]:
    """Pull (confidence, recommendation, signal_quote, inferred_problem) from
    the LLM rationale. The numeric intent_score is computed deterministically
    from cosines, not parsed from the LLM output."""
    m = re.search(r"^##\s*Confidence:\s*(low|medium|high)", md, re.M | re.I)
    if not m:
        m = re.search(r"Confidence:\s*(low|medium|high)", md, re.I)
    if m:
        confidence = m.group(1).lower()
    recommendation = "drop"
    m = re.search(r"^##\s*Recommendation\s*\n+\s*(pursue|watch|drop)\b", md, re.M | re.I)
    if not m:
        m = re.search(r"Recommendation[^\n]*\n[^\w]*(pursue|watch|drop)", md, re.I)
    if m:
        recommendation = m.group(1).lower()

    # Optional signal quote / inferred problem
    quote = ""
    m = re.search(r"signal[^\n]*?[:\-]\s*\"([^\"\n]+)\"", md, re.I)
    if m:
        quote = m.group(1)[:300]
    problem = ""
    m = re.search(r"inferred[^\n]*?problem[^\n]*?[:\-]\s*([^\n]+)", md, re.I)
    if m:
        problem = m.group(1).strip()[:300]
    return confidence, recommendation, quote, problem


async def score_post(client: openai.AsyncOpenAI, model: str, post_row, parent_understanding: str,
                      base_prompt: str, fewshots: list,
                      corpus_matches: list[dict] | None = None) -> tuple[int, str, str, str, str, str]:
    """Returns (intent_score, confidence, recommendation, quote, problem, rationale_md).

    intent_score is DETERMINISTIC from cosine_intent_score(corpus_matches).
    The LLM call generates the rationale_md (audit blob) — it does NOT decide
    the score.
    """
    intent_score = cosine_intent_score(corpus_matches)

    sys_prompt = base_prompt
    fewshot_block = format_fewshots_block(fewshots)
    if fewshot_block:
        sys_prompt = base_prompt + "\n\n" + fewshot_block
    user = build_post_input(post_row, parent_understanding, corpus_matches=corpus_matches)
    try:
        r = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user},
            ],
            max_completion_tokens=MAX_TOKENS,
        )
    except openai.APIError as e:
        return intent_score, "low", "drop", "", "", f"# Rationale failed\n\nERROR: {type(e).__name__}: {e}\n"
    content = (r.choices[0].message.content or "").strip()
    if content.startswith("```"):
        first_nl = content.find("\n")
        if first_nl != -1:
            content = content[first_nl + 1:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()
    conf, rec, quote, problem = parse_score_from_md(content)
    return intent_score, conf, rec, quote, problem, content


def _refresh_cumulative_for_post(con, post_row, *, now: datetime) -> None:
    """After a post is scored, refresh cumulative for both attached entities."""
    if post_row["lead_id"]:
        crm.update_entity_cumulative(con, "lead", post_row["lead_id"], now=now)
    if post_row["account_id"]:
        crm.update_entity_cumulative(con, "account", post_row["account_id"], now=now)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="rescore even posts that already have intent_score")
    parser.add_argument("--post-id", default=None, help="score a single post by id")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--emit-cards", action="store_true",
                        help="also write score/<entity_slug>.md cards (per-entity rollup)")
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set")
        return 2

    base_prompt = load_prompt("score")
    fewshots = load_fewshots("score", max_examples=5)
    if fewshots:
        print(f"[score] using {len(fewshots)} fewshot example(s)")

    crm.init()

    with crm.connect() as con:
        if args.post_id:
            posts = con.execute("SELECT * FROM posts WHERE post_id=?", (args.post_id,)).fetchall()
        elif args.force:
            posts = con.execute("SELECT * FROM posts ORDER BY posted_at ASC").fetchall()
        else:
            posts = con.execute(
                "SELECT * FROM posts WHERE intent_score IS NULL ORDER BY posted_at ASC"
            ).fetchall()

    if not posts:
        print("[score] no posts to score")
        if args.emit_cards:
            _emit_cards()
        return 0

    print(f"[score] scoring {len(posts)} posts, model={args.model}")
    client = openai.AsyncOpenAI()
    sem = asyncio.Semaphore(PARALLEL)

    async def _runner(post_row):
        async with sem:
            # Get parent understanding (prefer lead, fall back to account)
            parent_understanding = ""
            corpus_matches: list[dict] = []
            with crm.connect() as con:
                if post_row["lead_id"]:
                    e = con.execute("SELECT understanding_md FROM leads WHERE lead_id=?",
                                     (post_row["lead_id"],)).fetchone()
                    if e and e["understanding_md"]:
                        parent_understanding = e["understanding_md"]
                if not parent_understanding and post_row["account_id"]:
                    e = con.execute("SELECT understanding_md FROM accounts WHERE account_id=?",
                                     (post_row["account_id"],)).fetchone()
                    if e and e["understanding_md"]:
                        parent_understanding = e["understanding_md"]
                # NEW: per-post cosine vs Sim corpus → grounds the LLM's score
                # in actual Sim doc/blog/template content
                if post_row["embedding"]:
                    corpus_matches = crm.cosine_match_post_to_corpus(
                        con, post_row["post_id"], top_k=5, min_cosine=0.50
                    )

            score, conf, rec, quote, problem, content = await score_post(
                client, args.model, post_row, parent_understanding, base_prompt, fewshots,
                corpus_matches=corpus_matches,
            )
            return post_row, score, conf, rec, quote, problem, content, corpus_matches

    started = time.time()
    results = await asyncio.gather(*(_runner(p) for p in posts))

    now = datetime.now(timezone.utc)
    with crm.connect() as con:
        for post_row, score, conf, rec, quote, problem, content, corpus_matches in results:
            # Persist per-post top corpus matches as a markdown blob for the
            # timeline audit block + future analysis.
            top_match_md = ""
            if corpus_matches:
                lines = []
                for m in corpus_matches[:5]:
                    lines.append(f"- [{m['kind']}] **{m['name']}** (cosine {m['cosine_score']:.3f})")
                    lines.append(f"  {m['description'][:160]}")
                top_match_md = "\n".join(lines)
            con.execute(
                "UPDATE posts SET intent_score=?, signal_quote=?, inferred_problem=?, "
                "score_md=?, score_confidence=?, top_corpus_match_md=? WHERE post_id=?",
                (score, quote, problem, content, conf, top_match_md, post_row["post_id"]),
            )
        con.commit()

        # Refresh cumulative for every entity that owns one of the scored posts
        touched_entities: set[tuple[str, str]] = set()
        for post_row, _, _, _, _, _, _, _ in results:
            if post_row["lead_id"]:
                touched_entities.add(("lead", post_row["lead_id"]))
            if post_row["account_id"]:
                touched_entities.add(("account", post_row["account_id"]))
        for et, eid in touched_entities:
            crm.update_entity_cumulative(con, et, eid, now=now)
        # Distribution by score
        score_dist: dict[int, int] = {}
        for tup in results:
            s = tup[1]
            score_dist[s] = score_dist.get(s, 0) + 1
        crm.log_decision(con, action="score",
                          summary=f"scored {len(results)} posts; touched {len(touched_entities)} entities",
                          metadata={"by_score": {str(k): v for k, v in score_dist.items()}})
        con.commit()

    elapsed = time.time() - started
    print(f"[score] {len(results)} posts scored in {elapsed:.1f}s")
    for s in sorted(score_dist.keys(), reverse=True):
        print(f"  score {s}: {score_dist[s]}")

    if args.emit_cards:
        _emit_cards()

    await client.close()
    return 0


# ---------------------------------------------------------------------------
# Per-entity rollup card (review surface)

def _emit_cards() -> None:
    """Write score/<entity_slug>.md per entity + score/_ranked.md aggregate."""
    SCORE_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    with crm.connect() as con:
        for et in ("account", "lead"):
            id_col = "account_id" if et == "account" else "lead_id"
            table = "accounts" if et == "account" else "leads"
            entities = con.execute(
                f"SELECT * FROM {table} WHERE cumulative_score > 0 OR understanding_md IS NOT NULL"
            ).fetchall()
            for e in entities:
                eid = e[id_col]
                posts = crm.fetch_posts_for_entity(con, et, eid, limit=20)
                slug = _slug(et, eid)
                # Card per entity
                card = _render_entity_card(et, e, posts)
                write_md_with_original(SCORE_DIR, slug, card, force=True)

                # Ranked row
                top_post = max(posts, key=lambda p: (p["intent_score"] or 0)) if posts else None
                rows.append({
                    "entity_type": et,
                    "entity_id": eid,
                    "name": e["name"],
                    "cumulative": float(e["cumulative_score"] or 0),
                    "post_count": len(posts),
                    "top_intent": (top_post["intent_score"] if top_post else 0) or 0,
                })

    rows.sort(key=lambda r: -r["cumulative"])
    lines = [
        "# Ranked entities by cumulative score",
        "",
        "| type    | name                       | cumulative | top post | posts | recommendation |",
        "|---------|----------------------------|------------|----------|-------|----------------|",
    ]
    for r in rows:
        cum = r["cumulative"]
        rec = "pursue" if cum >= 12 else ("watch" if cum >= 6 else "drop")
        lines.append(
            f"| {r['entity_type']:<7} | {r['name'][:26]:<26} | {cum:>10.2f} | "
            f"{r['top_intent']:>2}/10    | {r['post_count']:>5} | {rec:<14} |"
        )
    RANKED_PATH.write_text("\n".join(lines))
    print(f"  wrote {RANKED_PATH.relative_to(REPO_ROOT)}")


def _render_entity_card(entity_type: str, entity_row, posts) -> str:
    name = entity_row["name"]
    cum = entity_row["cumulative_score"] or 0.0
    rec = "pursue" if cum >= 12 else ("watch" if cum >= 6 else "drop")
    lines = [
        f"# Score card: {name}",
        "",
        f"**Type:** {entity_type}",
        f"**Cumulative score (14d, decayed):** {cum:.2f}",
        f"**Recommendation:** {rec}",
        f"**Posts attached:** {len(posts)}",
        "",
        "## Per-post scores",
        "",
        "| posted_at | channel | score | quote |",
        "|-----------|---------|-------|-------|",
    ]
    for p in posts:
        lines.append(
            f"| {p['posted_at'][:10]} | {p['channel']:<8} | {(p['intent_score'] or 0):>2}/10 | "
            f"{(p['signal_quote'] or '')[:60]} |"
        )
    lines.append("")
    lines.append("## Drop this row")
    lines.append("no")
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
