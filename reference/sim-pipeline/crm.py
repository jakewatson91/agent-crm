"""
CRM data layer for the P2 pipeline (golden-replay edition).

SQLite at scripts/.cache/crm.sqlite. Source of truth across runs.
The .md files in understand/, score/, match/, replay/, triggers/ are derived
views — the CRM rows are what survives.

Schema:
  accounts (companies)        — has understanding_md + embedding + cumulative_score
  leads (people)              — has parent_account_id, understanding_md, embedding
  posts (evidence rows)        — attach to lead AND/OR account; has posted_at + intent_score
  templates (Sim workflows)    — name + category + inferred_purpose + embedding
  matches                     — (entity_type, entity_id, template_id) cosine + reasoning
  triggers                    — fired alerts: type, entity, evidence, fired_at_post_time

Embeddings: BAAI/bge-small-en-v1.5 (384-dim), normalized, stored as float32 BLOB.
Cosine similarity in NumPy at query time.

Usage:
    from scripts.p2 import crm
    crm.init()
    with crm.connect() as con:
        crm.upsert_account(con, ...)
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = REPO_ROOT / "scripts" / ".cache" / "crm.sqlite"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    understanding_md TEXT,
    embedding BLOB,
    cumulative_score REAL DEFAULT 0,
    last_evidence_at TIMESTAMP,
    status TEXT DEFAULT 'watching',
    last_updated TIMESTAMP,
    icp_fit TEXT,                      -- 'high' | 'medium' | 'low' | NULL
    icp_themes TEXT,                   -- JSON array of theme strings
    icp_role_context TEXT,             -- free-text: stage, role, decision-power
    icp_note_hook TEXT,                -- suggested opener for send_note action
    icp_md TEXT                        -- full classifier output for audit
);
CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain);

CREATE TABLE IF NOT EXISTS leads (
    lead_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT,
    handle TEXT,
    parent_account_id TEXT,
    understanding_md TEXT,
    embedding BLOB,
    cumulative_score REAL DEFAULT 0,
    last_evidence_at TIMESTAMP,
    status TEXT DEFAULT 'watching',
    last_updated TIMESTAMP,
    icp_fit TEXT,
    icp_themes TEXT,
    icp_role_context TEXT,
    icp_note_hook TEXT,
    icp_md TEXT,
    FOREIGN KEY (parent_account_id) REFERENCES accounts(account_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(parent_account_id);

CREATE TABLE IF NOT EXISTS posts (
    post_id TEXT PRIMARY KEY,
    lead_id TEXT,
    account_id TEXT,
    channel TEXT,
    url TEXT,
    author_handle TEXT,
    posted_at TIMESTAMP,
    seen_at TIMESTAMP,
    title TEXT,
    text TEXT,
    raw_json TEXT,
    intent_score INTEGER,
    inferred_problem TEXT,
    signal_quote TEXT,
    score_md TEXT,
    score_confidence TEXT,
    FOREIGN KEY (lead_id) REFERENCES leads(lead_id),
    FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_lead ON posts(lead_id);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_posts_url ON posts(url);
CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);

CREATE TABLE IF NOT EXISTS templates (
    template_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    tags TEXT DEFAULT '[]',
    embedding BLOB
);

CREATE TABLE IF NOT EXISTS matches (
    entity_type TEXT,
    entity_id TEXT,
    template_id TEXT,
    cosine_score REAL,
    matched_at TIMESTAMP,
    status TEXT DEFAULT 'auto',
    reasoning TEXT,
    PRIMARY KEY (entity_type, entity_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_entity ON matches(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

CREATE TABLE IF NOT EXISTS triggers (
    trigger_id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    trigger_type TEXT,
    evidence_post_id TEXT,
    fired_at_post_time TIMESTAMP,
    replayed_at TIMESTAMP,
    status TEXT DEFAULT 'pending',
    evidence_summary TEXT,
    FOREIGN KEY (evidence_post_id) REFERENCES posts(post_id)
);
CREATE INDEX IF NOT EXISTS idx_triggers_entity ON triggers(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_triggers_fired ON triggers(fired_at_post_time);

CREATE TABLE IF NOT EXISTS decisions (
    decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    happened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,
    summary TEXT,
    entity_type TEXT,
    entity_id TEXT,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_happened ON decisions(happened_at);
"""


_embedder = None


def get_embedder():
    global _embedder
    if _embedder is None:
        from fastembed import TextEmbedding
        _embedder = TextEmbedding(model_name=EMBED_MODEL)
    return _embedder


def embed_text(text: str) -> np.ndarray:
    embedder = get_embedder()
    vec = next(iter(embedder.embed([text])))
    norm = np.linalg.norm(vec)
    if norm < 1e-9:
        return vec.astype(np.float32)
    return (vec / norm).astype(np.float32)


def embed_many(texts: list[str]) -> list[np.ndarray]:
    embedder = get_embedder()
    out = []
    for vec in embedder.embed(texts):
        norm = np.linalg.norm(vec)
        out.append((vec / max(norm, 1e-9)).astype(np.float32))
    return out


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.executescript(SCHEMA)
        con.commit()


def reset() -> None:
    """Wipe the database and rebuild schema from scratch. Destructive."""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init()


@contextmanager
def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
    finally:
        con.close()


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")
    return s or "unknown"


# ----------------------------------------------------------------------------
# Account / Lead upserts

def upsert_account(
    con: sqlite3.Connection,
    *,
    account_id: str,
    name: str,
    domain: str = "",
) -> None:
    existing = con.execute(
        "SELECT account_id, name, domain FROM accounts WHERE account_id = ?",
        (account_id,),
    ).fetchone()
    if existing is None:
        con.execute(
            "INSERT INTO accounts (account_id, name, domain, last_updated) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            (account_id, name, domain),
        )
        return
    new_name = existing["name"] or name
    new_domain = existing["domain"] or domain
    con.execute(
        "UPDATE accounts SET name=?, domain=?, last_updated=CURRENT_TIMESTAMP "
        "WHERE account_id=?",
        (new_name, new_domain, account_id),
    )


def upsert_lead(
    con: sqlite3.Connection,
    *,
    lead_id: str,
    name: str,
    channel: str = "",
    handle: str = "",
    parent_account_id: Optional[str] = None,
) -> None:
    existing = con.execute(
        "SELECT * FROM leads WHERE lead_id = ?", (lead_id,)
    ).fetchone()
    if existing is None:
        con.execute(
            "INSERT INTO leads (lead_id, name, channel, handle, parent_account_id, last_updated) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            (lead_id, name, channel, handle, parent_account_id),
        )
        return
    con.execute(
        "UPDATE leads SET name=COALESCE(name,?), channel=COALESCE(NULLIF(channel,''),?), "
        "handle=COALESCE(NULLIF(handle,''),?), parent_account_id=COALESCE(parent_account_id,?), "
        "last_updated=CURRENT_TIMESTAMP WHERE lead_id=?",
        (name, channel, handle, parent_account_id, lead_id),
    )


def upsert_post(
    con: sqlite3.Connection,
    *,
    post_id: str,
    lead_id: Optional[str],
    account_id: Optional[str],
    channel: str,
    url: str,
    author_handle: str = "",
    posted_at: str = "",
    title: str = "",
    text: str = "",
    raw: Optional[dict] = None,
) -> None:
    raw_json = json.dumps(raw or {}, ensure_ascii=False)
    con.execute(
        """INSERT OR REPLACE INTO posts
           (post_id, lead_id, account_id, channel, url, author_handle,
            posted_at, seen_at, title, text, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)""",
        (post_id, lead_id, account_id, channel, url, author_handle,
         posted_at, title, text, raw_json),
    )


def update_entity_understanding(
    con: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    understanding_md: str,
) -> None:
    """Save comprehension doc + recompute embedding. Works for accounts or leads."""
    emb = embed_text(understanding_md)
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    con.execute(
        f"UPDATE {table} SET understanding_md=?, embedding=?, last_updated=CURRENT_TIMESTAMP "
        f"WHERE {id_col}=?",
        (understanding_md, emb.tobytes(), entity_id),
    )


def upsert_template(
    con: sqlite3.Connection,
    *,
    template_id: str,
    name: str,
    category: str = "",
    description: str = "",
    tags: Optional[list] = None,
    embedding: Optional[np.ndarray] = None,
) -> None:
    emb_blob = embedding.tobytes() if embedding is not None else None
    con.execute(
        """INSERT OR REPLACE INTO templates (template_id, name, category, description, tags, embedding)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (template_id, name, category, description, json.dumps(tags or []), emb_blob),
    )


# ----------------------------------------------------------------------------
# Lookup helpers

def fetch_entity(con: sqlite3.Connection, entity_type: str, entity_id: str) -> Optional[sqlite3.Row]:
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    return con.execute(f"SELECT * FROM {table} WHERE {id_col}=?", (entity_id,)).fetchone()


def fetch_all_entities(con: sqlite3.Connection, entity_type: str,
                       *, with_understanding: Optional[bool] = None) -> list[sqlite3.Row]:
    table = "accounts" if entity_type == "account" else "leads"
    sql = f"SELECT * FROM {table}"
    if with_understanding is True:
        sql += " WHERE understanding_md IS NOT NULL AND understanding_md != ''"
    elif with_understanding is False:
        sql += " WHERE understanding_md IS NULL OR understanding_md = ''"
    sql += " ORDER BY last_updated DESC"
    return con.execute(sql).fetchall()


def find_top_lead_for_account(
    con: sqlite3.Connection, account_id: str,
) -> Optional[sqlite3.Row]:
    """Resolve which lead at this account should receive outreach.

    Ranking (in order):
      1. Highest cumulative_score
      2. Most-recent post activity (last_evidence_at)
      3. Most posts attached
      4. Stable lead_id alphabetic

    Returns None if no leads attached to this account.
    """
    return con.execute("""
        SELECT l.*,
               COUNT(p.post_id) AS post_count,
               MAX(p.posted_at) AS last_post_at
        FROM leads l
        LEFT JOIN posts p ON p.lead_id = l.lead_id
        WHERE l.parent_account_id = ?
          AND (l.status IS NULL OR l.status != 'dropped')
        GROUP BY l.lead_id
        ORDER BY
          (l.cumulative_score IS NULL) ASC,
          l.cumulative_score DESC,
          l.last_evidence_at DESC,
          post_count DESC,
          l.lead_id ASC
        LIMIT 1
    """, (account_id,)).fetchone()


def fetch_posts_for_entity(
    con: sqlite3.Connection, entity_type: str, entity_id: str,
    *, limit: int = 50, before: Optional[str] = None,
) -> list[sqlite3.Row]:
    """Posts attached to this entity, sorted by posted_at DESC.

    `before`: optional ISO timestamp — only return posts with posted_at < before
    (used by replay engine to limit to "what we'd have seen by this tick").
    """
    id_col = "account_id" if entity_type == "account" else "lead_id"
    sql = f"SELECT * FROM posts WHERE {id_col} = ?"
    params: list = [entity_id]
    if before:
        sql += " AND posted_at < ?"
        params.append(before)
    sql += " ORDER BY posted_at DESC LIMIT ?"
    params.append(limit)
    return con.execute(sql, params).fetchall()


def fetch_all_posts_chronological(con: sqlite3.Connection) -> list[sqlite3.Row]:
    """All posts in posted_at ASC order. Drives replay."""
    return con.execute(
        "SELECT * FROM posts WHERE posted_at IS NOT NULL AND posted_at != '' "
        "ORDER BY posted_at ASC"
    ).fetchall()


def fetch_templates_with_embeddings(con: sqlite3.Connection) -> list[tuple]:
    rows = con.execute(
        "SELECT template_id, name, category, description, embedding FROM templates "
        "WHERE embedding IS NOT NULL"
    ).fetchall()
    out = []
    for r in rows:
        emb = np.frombuffer(r["embedding"], dtype=np.float32)
        out.append((r["template_id"], r["name"], r["category"], r["description"] or "", emb))
    return out


SIM_DOCS_PATH = REPO_ROOT / "scripts" / ".cache" / "sim_docs.sqlite"


import re as _re_corpus

# Tool-doc slug pattern: docs-sim-ai-tools-<name> or docs-sim-ai-triggers-<name>.
# These chunks should only be retrieved if the entity's understanding doc
# explicitly mentions the tool name. Otherwise, integration tool docs swamp
# the cosine ranking just because they have many chunks (Stripe alone has
# 119 chunks vs blocks-parallel's 6).
_TOOL_SLUG_RE = _re_corpus.compile(r"docs-sim-ai-(?:tools|triggers)-([a-z0-9-]+)")

# Architectural-primitive slugs get a small boost so they bubble up above
# generic tool docs that share the same word-frequency space as everything else.
# These are Sim's distinctive capabilities — when a company's understanding
# matches them at all, that's a stronger signal than "your text contains the
# word 'data' which Stripe's docs also contain."
_ARCHITECTURAL_PATTERNS = (
    "docs-sim-ai-blocks",       # parallel, loop, agent, router, condition, function, …
    "docs-sim-ai-mcp",          # MCP integration
    "docs-sim-ai-mothership",   # mothership, tasks, schedules
    "docs-sim-ai-knowledgebase",
    "docs-sim-ai-concepts",
    "blog-",                    # all blog posts (mothership, executor, multiplayer, …)
)
_ARCHITECTURAL_BOOST = 0.04  # additive — equivalent to ~one rank position


def _tool_name_from_slug(slug: str) -> str | None:
    m = _TOOL_SLUG_RE.match(slug)
    if not m:
        return None
    name = m.group(1)
    # Skip filtering on extremely short names ("x", "ai") — they false-match.
    # Treat short-named tools as "always allowed" rather than always-excluded:
    # the cosine score will decide whether they surface.
    if len(name) < 4:
        return None
    return name


def _understanding_mentions_tool(understanding_md: str, tool_name: str) -> bool:
    """Does the entity's understanding doc mention this tool by name?
    Tolerant: matches whole-word, case-insensitive. Allows hyphen variants.
    """
    if not understanding_md or not tool_name:
        return False
    haystack = understanding_md.lower()
    # Try exact, normalized variants (replace - with space and concat)
    variants = {tool_name, tool_name.replace("-", ""), tool_name.replace("-", " ")}
    for v in variants:
        if v and v in haystack:
            return True
    return False


def cosine_match_post_to_corpus(
    con: sqlite3.Connection,
    post_id: str,
    *,
    top_k: int = 5,
    min_cosine: float = 0.50,
) -> list[dict]:
    """Cosine-match a single post's embedding against the unified Sim corpus
    (templates + sim_docs). Same shape as cosine_match_entity_to_corpus.

    Used by score.py to ground per-post LLM judgments in actual Sim content,
    and by replay.py to show "this post most resembles which Sim primitive."
    """
    row = con.execute(
        "SELECT embedding FROM posts WHERE post_id=?", (post_id,)
    ).fetchone()
    if row is None or row["embedding"] is None:
        return []
    p_vec = np.frombuffer(row["embedding"], dtype=np.float32)

    candidates: list[dict] = []

    # Templates
    template_rows = con.execute(
        "SELECT template_id, name, category, description, embedding FROM templates "
        "WHERE embedding IS NOT NULL"
    ).fetchall()
    if template_rows:
        embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in template_rows])
        norms = np.linalg.norm(embs, axis=1, keepdims=True)
        embs = embs / np.maximum(norms, 1e-9)
        scores = embs @ p_vec
        for i, r in enumerate(template_rows):
            if scores[i] >= min_cosine:
                candidates.append({
                    "kind": "template",
                    "id": r["template_id"],
                    "name": r["name"],
                    "category": r["category"] or "",
                    "description": r["description"] or "",
                    "cosine_score": float(scores[i]),
                })

    # Sim docs
    if SIM_DOCS_PATH.exists():
        docs_con = sqlite3.connect(SIM_DOCS_PATH)
        docs_con.row_factory = sqlite3.Row
        try:
            doc_rows = docs_con.execute(
                "SELECT source, url, slug, content, embedding FROM chunks "
                "WHERE embedding IS NOT NULL"
            ).fetchall()
        finally:
            docs_con.close()
        if doc_rows:
            embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in doc_rows])
            norms = np.linalg.norm(embs, axis=1, keepdims=True)
            embs = embs / np.maximum(norms, 1e-9)
            scores = embs @ p_vec
            for i, r in enumerate(doc_rows):
                if scores[i] < min_cosine:
                    continue
                slug = r["slug"] or ""
                effective = float(scores[i])
                if any(slug.startswith(p) for p in _ARCHITECTURAL_PATTERNS):
                    effective += _ARCHITECTURAL_BOOST
                candidates.append({
                    "kind": "doc",
                    "id": slug,
                    "name": slug,
                    "category": r["source"] or "doc",
                    "description": (r["content"] or "")[:400],
                    "cosine_score": effective,
                })

    candidates.sort(key=lambda c: -c["cosine_score"])
    return candidates[:top_k]


def embed_and_store_post(con: sqlite3.Connection, post_id: str, text: str) -> None:
    """Compute the embedding for a post and persist it. Idempotent."""
    if not text or not text.strip():
        return
    emb = embed_text(text[:4000])
    con.execute("UPDATE posts SET embedding=? WHERE post_id=?", (emb.tobytes(), post_id))


def cosine_match_entity_to_corpus(
    con: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    *,
    top_k: int = 10,
    min_cosine: float = 0.50,
) -> list[dict]:
    """Unified retrieval across BOTH the templates table and the sim_docs corpus.

    Returns top_k results sorted desc by cosine, each item tagged with
    `kind` = 'template' | 'doc'. This is the right shape for downstream
    decision-making: the LLM sees the entire ranked frontier of "things
    Sim has that could match this entity" and decides what to ship.

    The two corpora share the same embedding model (BAAI/bge-small-en-v1.5)
    so cosine scores are directly comparable.

    Tool integration docs (`docs-sim-ai-tools-<name>` and `triggers-<name>`)
    are filtered out UNLESS the entity's understanding_md mentions that
    tool by name. This prevents Stripe/SAP/GitHub tool docs from drowning
    out architectural primitives (Parallel block, Agent, Memory, MCP) just
    because they have far more chunks indexed.
    """
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    row = con.execute(
        f"SELECT embedding, understanding_md FROM {table} WHERE {id_col}=?", (entity_id,)
    ).fetchone()
    if row is None or row["embedding"] is None:
        return []
    e_vec = np.frombuffer(row["embedding"], dtype=np.float32)
    understanding_md = row["understanding_md"] or ""

    candidates: list[dict] = []

    # 1. Templates corpus
    template_rows = con.execute(
        "SELECT template_id, name, category, description, embedding FROM templates "
        "WHERE embedding IS NOT NULL"
    ).fetchall()
    if template_rows:
        embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in template_rows])
        norms = np.linalg.norm(embs, axis=1, keepdims=True)
        embs = embs / np.maximum(norms, 1e-9)
        scores = embs @ e_vec
        for i, r in enumerate(template_rows):
            if scores[i] >= min_cosine:
                candidates.append({
                    "kind": "template",
                    "id": r["template_id"],
                    "name": r["name"],
                    "category": r["category"] or "",
                    "description": r["description"] or "",
                    "url": "",
                    "cosine_score": float(scores[i]),
                })

    # 2. Sim docs corpus (read-only sibling DB), filtered to drop tool docs
    # the entity doesn't actually mention.
    if SIM_DOCS_PATH.exists():
        docs_con = sqlite3.connect(SIM_DOCS_PATH)
        docs_con.row_factory = sqlite3.Row
        try:
            doc_rows = docs_con.execute(
                "SELECT source, url, slug, content, embedding FROM chunks "
                "WHERE embedding IS NOT NULL"
            ).fetchall()
        finally:
            docs_con.close()
        if doc_rows:
            embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in doc_rows])
            norms = np.linalg.norm(embs, axis=1, keepdims=True)
            embs = embs / np.maximum(norms, 1e-9)
            scores = embs @ e_vec
            for i, r in enumerate(doc_rows):
                slug = r["slug"] or ""
                tool_name = _tool_name_from_slug(slug)
                if tool_name and not _understanding_mentions_tool(understanding_md, tool_name):
                    # Tool integration doc, but the entity never mentions it. Skip.
                    continue
                effective = float(scores[i])
                # Boost architectural primitives + blog posts so they bubble
                # above generic tool docs.
                if any(slug.startswith(p) for p in _ARCHITECTURAL_PATTERNS):
                    effective += _ARCHITECTURAL_BOOST
                if effective < min_cosine:
                    continue
                candidates.append({
                    "kind": "doc",
                    "id": slug,
                    "name": slug,
                    "category": r["source"] or "doc",
                    "description": (r["content"] or "")[:400],
                    "url": r["url"] or "",
                    "cosine_score": effective,
                    "raw_cosine": float(scores[i]),
                })

    candidates.sort(key=lambda c: -c["cosine_score"])
    return candidates[:top_k]


def cosine_match_entity_to_sim_docs(
    con: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    *,
    top_k: int = 5,
) -> list[dict]:
    """Cosine-match an entity's embedding against the local Sim docs corpus
    (3839 chunks across docs.sim.ai + blog + GitHub README). Returns top_k
    chunks with similarity scores.

    This is a SEPARATE READ-ONLY corpus from the CRM. It exists at
    scripts/.cache/sim_docs.sqlite and was built by the prior session's
    ingest_local.py.
    """
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    row = con.execute(
        f"SELECT embedding FROM {table} WHERE {id_col}=?", (entity_id,)
    ).fetchone()
    if row is None or row["embedding"] is None:
        return []
    if not SIM_DOCS_PATH.exists():
        return []
    e_vec = np.frombuffer(row["embedding"], dtype=np.float32)

    docs_con = sqlite3.connect(SIM_DOCS_PATH)
    docs_con.row_factory = sqlite3.Row
    try:
        rows = docs_con.execute(
            "SELECT source, url, slug, content, embedding FROM chunks "
            "WHERE embedding IS NOT NULL"
        ).fetchall()
    finally:
        docs_con.close()
    if not rows:
        return []

    embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    norms = np.linalg.norm(embs, axis=1, keepdims=True)
    embs = embs / np.maximum(norms, 1e-9)
    scores = embs @ e_vec
    idxs = np.argsort(-scores)[:top_k]
    return [
        {
            "source": rows[i]["source"],
            "url": rows[i]["url"],
            "slug": rows[i]["slug"],
            "content": (rows[i]["content"] or "")[:600],
            "cosine_score": float(scores[i]),
        }
        for i in idxs
    ]


def cosine_match_entity_to_templates(
    con: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    *,
    top_k: int = 5,
) -> list[dict]:
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    row = con.execute(
        f"SELECT embedding FROM {table} WHERE {id_col}=?", (entity_id,)
    ).fetchone()
    if row is None or row["embedding"] is None:
        return []
    e_vec = np.frombuffer(row["embedding"], dtype=np.float32)
    templates = fetch_templates_with_embeddings(con)
    if not templates:
        return []
    embs = np.stack([t[4] for t in templates])
    scores = embs @ e_vec
    idxs = np.argsort(-scores)[:top_k]
    return [
        {
            "template_id": templates[i][0],
            "name": templates[i][1],
            "category": templates[i][2],
            "description": templates[i][3],
            "cosine_score": float(scores[i]),
        }
        for i in idxs
    ]


def upsert_match(
    con: sqlite3.Connection,
    *,
    entity_type: str,
    entity_id: str,
    template_id: str,
    cosine_score: float,
    status: str = "auto",
    reasoning: str = "",
) -> None:
    existing = con.execute(
        "SELECT status FROM matches WHERE entity_type=? AND entity_id=? AND template_id=?",
        (entity_type, entity_id, template_id),
    ).fetchone()
    if existing and existing["status"] == "user_rejected" and status == "auto":
        return
    con.execute(
        """INSERT OR REPLACE INTO matches
           (entity_type, entity_id, template_id, cosine_score, matched_at, status, reasoning)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)""",
        (entity_type, entity_id, template_id, cosine_score, status, reasoning),
    )


def insert_trigger(
    con: sqlite3.Connection,
    *,
    trigger_id: str,
    entity_type: str,
    entity_id: str,
    trigger_type: str,
    evidence_post_id: Optional[str],
    fired_at_post_time: str,
    evidence_summary: str = "",
) -> None:
    # Don't duplicate the same fire (idempotent on trigger_id)
    con.execute(
        """INSERT OR REPLACE INTO triggers
           (trigger_id, entity_type, entity_id, trigger_type, evidence_post_id,
            fired_at_post_time, replayed_at, status, evidence_summary)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending', ?)""",
        (trigger_id, entity_type, entity_id, trigger_type, evidence_post_id,
         fired_at_post_time, evidence_summary),
    )


# ----------------------------------------------------------------------------
# Cumulative score with time-decay

DECAY_HALF_LIFE_DAYS = 7.0


def cumulative_score_for_posts(posts: list[sqlite3.Row], *, now: datetime,
                                window_days: int = 14) -> float:
    """Weighted sum of intent_score * exp(-days_since_post / 7).

    Only counts posts within window_days of `now`. Posts without intent_score
    contribute 0.
    """
    total = 0.0
    cutoff = now - timedelta(days=window_days)
    for p in posts:
        score = p["intent_score"] if p["intent_score"] is not None else 0
        if score == 0:
            continue
        try:
            posted = datetime.fromisoformat(p["posted_at"].replace("Z", "+00:00"))
            if posted.tzinfo is None:
                posted = posted.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError, AttributeError):
            continue
        if posted < cutoff:
            continue
        days = (now - posted).total_seconds() / 86400.0
        weight = math.exp(-days / DECAY_HALF_LIFE_DAYS)
        total += score * weight
    return round(total, 2)


def update_entity_cumulative(
    con: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    *,
    now: datetime,
) -> float:
    """Recompute and persist cumulative_score for one entity. Returns new value."""
    posts = fetch_posts_for_entity(con, entity_type, entity_id, limit=200)
    cum = cumulative_score_for_posts(posts, now=now)
    table = "accounts" if entity_type == "account" else "leads"
    id_col = "account_id" if entity_type == "account" else "lead_id"
    con.execute(
        f"UPDATE {table} SET cumulative_score=?, last_evidence_at=? WHERE {id_col}=?",
        (cum, now.isoformat(), entity_id),
    )
    return cum


# ----------------------------------------------------------------------------
# Domain helpers

def domain_to_account_id(domain: str) -> str:
    """Normalize a domain to a stable account_id."""
    d = (domain or "").lower().strip()
    d = re.sub(r"^https?://", "", d).split("/", 1)[0].replace("www.", "")
    return d if d and "." in d else slugify(domain)


# ----------------------------------------------------------------------------
# Stats (used by status.py)

def log_decision(
    con: sqlite3.Connection,
    *,
    action: str,
    summary: str = "",
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Append a row to decisions. Used by all pipeline scripts to leave a trail."""
    con.execute(
        """INSERT INTO decisions (action, summary, entity_type, entity_id, metadata_json)
           VALUES (?, ?, ?, ?, ?)""",
        (action, summary, entity_type, entity_id,
         json.dumps(metadata) if metadata else None),
    )


def fetch_decisions(con: sqlite3.Connection, *, limit: int = 30) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM decisions ORDER BY happened_at DESC, decision_id DESC LIMIT ?",
        (limit,),
    ).fetchall()


def stats(con: sqlite3.Connection) -> dict:
    return {
        "accounts": con.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
        "leads": con.execute("SELECT COUNT(*) FROM leads").fetchone()[0],
        "accounts_with_understanding": con.execute(
            "SELECT COUNT(*) FROM accounts WHERE understanding_md IS NOT NULL AND understanding_md != ''"
        ).fetchone()[0],
        "leads_with_understanding": con.execute(
            "SELECT COUNT(*) FROM leads WHERE understanding_md IS NOT NULL AND understanding_md != ''"
        ).fetchone()[0],
        "posts": con.execute("SELECT COUNT(*) FROM posts").fetchone()[0],
        "posts_scored": con.execute(
            "SELECT COUNT(*) FROM posts WHERE intent_score IS NOT NULL"
        ).fetchone()[0],
        "templates": con.execute("SELECT COUNT(*) FROM templates").fetchone()[0],
        "matches_auto": con.execute("SELECT COUNT(*) FROM matches WHERE status='auto'").fetchone()[0],
        "matches_confirmed": con.execute("SELECT COUNT(*) FROM matches WHERE status='user_confirmed'").fetchone()[0],
        "matches_rejected": con.execute("SELECT COUNT(*) FROM matches WHERE status='user_rejected'").fetchone()[0],
        "triggers": con.execute("SELECT COUNT(*) FROM triggers").fetchone()[0],
        "triggers_pending": con.execute("SELECT COUNT(*) FROM triggers WHERE status='pending'").fetchone()[0],
        "decisions": con.execute("SELECT COUNT(*) FROM decisions").fetchone()[0],
    }


if __name__ == "__main__":
    import argparse, sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="WIPE the database and recreate schema")
    args = parser.parse_args()
    if args.reset:
        reset()
        print(f"[crm] reset: rebuilt {DB_PATH.relative_to(REPO_ROOT)}")
    else:
        init()
        print(f"[crm] initialized {DB_PATH.relative_to(REPO_ROOT)}")
    with connect() as con:
        s = stats(con)
        for k, v in s.items():
            print(f"  {k:>32} : {v}")
    sys.exit(0)
