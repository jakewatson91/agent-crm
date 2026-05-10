"""
Ingest Sim blog posts into the sim_docs.sqlite corpus.

Reads from golden/_sim_blog/*.md (the blog content was fetched once via
WebFetch and saved to disk because the blog pages are Next.js client-rendered
and httpx returns empty bodies). Re-running this re-embeds and replaces
chunks for those slugs (idempotent).

The chunks land in sim_docs.sqlite alongside the existing 3839 chunks. They
share the same embedder (BAAI/bge-small-en-v1.5) so cosine scores stay
directly comparable.

Usage:
    python -m scripts.p2.ingest_sim_blog
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import numpy as np

from . import crm
from ._common import REPO_ROOT

BLOG_DIR = REPO_ROOT / "golden" / "_sim_blog"
SIM_DOCS_PATH = REPO_ROOT / "scripts" / ".cache" / "sim_docs.sqlite"
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200


def chunk_text(text: str, *, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size])
        start += size - overlap
    return chunks


def ensure_chunks_table(con: sqlite3.Connection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            source TEXT,
            url TEXT,
            slug TEXT,
            chunk_index INTEGER,
            content TEXT,
            embedding BLOB,
            PRIMARY KEY (slug, chunk_index)
        )
    """)


def replace_blog_chunks(slug: str, url: str, chunks: list[str], embeddings: list[np.ndarray]) -> int:
    con = sqlite3.connect(SIM_DOCS_PATH)
    try:
        ensure_chunks_table(con)
        con.execute("DELETE FROM chunks WHERE slug = ?", (slug,))
        for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
            con.execute(
                "INSERT INTO chunks (source, url, slug, chunk_index, content, embedding) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("blog", url, slug, i, chunk, emb.tobytes()),
            )
        con.commit()
        return len(chunks)
    finally:
        con.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=str(BLOG_DIR), type=Path)
    args = parser.parse_args()

    if not SIM_DOCS_PATH.exists():
        print(f"ERROR: {SIM_DOCS_PATH} not found")
        return 2
    if not args.dir.exists():
        print(f"ERROR: blog dir {args.dir} not found")
        return 2

    md_files = sorted(args.dir.glob("*.md"))
    if not md_files:
        print(f"ERROR: no .md files in {args.dir}")
        return 2

    print(f"[ingest_sim_blog] {len(md_files)} blog posts to ingest")
    total = 0
    for md_file in md_files:
        slug = f"blog-{md_file.stem}"
        url = f"https://www.sim.ai/blog/{md_file.stem}"
        body = md_file.read_text()
        chunks = chunk_text(body)
        if not chunks:
            print(f"  ✗  {md_file.name}: empty")
            continue
        embeddings = crm.embed_many(chunks)
        n = replace_blog_chunks(slug, url, chunks, embeddings)
        total += n
        print(f"  ✓  {slug:<32}  {n:>3} chunks ({len(body)} chars)")

    con = sqlite3.connect(SIM_DOCS_PATH)
    try:
        n_total = con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        n_blog = con.execute("SELECT COUNT(*) FROM chunks WHERE source='blog'").fetchone()[0]
    finally:
        con.close()
    print()
    print(f"[ingest_sim_blog] {total} chunks; corpus now {n_total} total ({n_blog} blog)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
