"""
Ingest manually-collected posts into the CRM.

Reads golden/_manual_posts.json (or any path passed in). Each entry:
    {
      "url": "...",
      "posted_at": "ISO timestamp",
      "text": "...",
      "channel": "linkedin" | "x" | "substack" | ...,
      "author_handle": "krabkin" | ...
    }

Resolves author_handle to a lead_id via config/golden_leads.yaml. Each lead
already has parent_account_name + parent_account_domain so the post gets
dual-attached to the lead AND its account.

Posts whose author_handle isn't found in the YAML are skipped with a warning
(so we don't accidentally create lead rows for handles we don't recognize).

Usage:
    python -m scripts.p2.ingest_manual                          # uses golden/_manual_posts.json
    python -m scripts.p2.ingest_manual path/to/posts.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from . import crm
from ._common import REPO_ROOT

CONFIG_PATH = REPO_ROOT / "config" / "golden_leads.yaml"
DEFAULT_INPUT = REPO_ROOT / "golden" / "_manual_posts.json"


def post_id_from_url(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:12]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, default=DEFAULT_INPUT)
    args = parser.parse_args()

    if not args.path.exists():
        print(f"ERROR: input not found: {args.path}")
        return 2
    if not CONFIG_PATH.exists():
        print(f"ERROR: golden_leads config not found: {CONFIG_PATH}")
        return 2

    config = yaml.safe_load(CONFIG_PATH.read_text())
    posts_in = json.loads(args.path.read_text())

    # Build handle → lead config map
    by_handle = {}
    for lead in config["leads"]:
        h = lead["handle"].lower().lstrip("@")
        by_handle[h] = lead

    crm.init()
    inserted = skipped = 0
    leads_seen: set[str] = set()
    accounts_seen: set[str] = set()
    skipped_handles: dict[str, int] = {}

    with crm.connect() as con:
        for post in posts_in:
            handle = (post.get("author_handle") or "").lower().lstrip("@")
            if not handle or handle not in by_handle:
                skipped += 1
                skipped_handles[handle or "(no handle)"] = skipped_handles.get(handle or "(no handle)", 0) + 1
                continue

            lead = by_handle[handle]
            lead_id = lead["lead_id"]
            account_id = crm.domain_to_account_id(lead["parent_account_domain"])

            # Ensure account + lead rows exist
            if account_id not in accounts_seen:
                crm.upsert_account(
                    con,
                    account_id=account_id,
                    name=lead["parent_account_name"],
                    domain=lead["parent_account_domain"],
                )
                accounts_seen.add(account_id)
            if lead_id not in leads_seen:
                crm.upsert_lead(
                    con,
                    lead_id=lead_id,
                    name=lead["name"],
                    channel=(lead.get("channels") or ["linkedin"])[0],
                    handle=lead["handle"],
                    parent_account_id=account_id,
                )
                leads_seen.add(lead_id)

            url = post["url"]
            post_id = post_id_from_url(url)

            crm.upsert_post(
                con,
                post_id=post_id,
                lead_id=lead_id,
                account_id=account_id,
                channel=post.get("channel") or "linkedin",
                url=url,
                author_handle=handle,
                posted_at=post.get("posted_at") or "",
                title=(post.get("text") or "")[:120],  # use first 120 chars as title
                text=post.get("text") or "",
                raw={"source": "manual", "input_file": str(args.path.relative_to(REPO_ROOT))},
            )
            inserted += 1
        crm.log_decision(con, action="ingest_manual",
                          summary=f"inserted {inserted} posts across {len(leads_seen)} leads / {len(accounts_seen)} accounts",
                          metadata={"input": str(args.path.relative_to(REPO_ROOT)),
                                    "leads": sorted(leads_seen),
                                    "accounts": sorted(accounts_seen),
                                    "skipped": skipped})
        con.commit()

    print(f"[ingest_manual] read {len(posts_in)} posts from {args.path.relative_to(REPO_ROOT)}")
    print(f"  inserted: {inserted}")
    print(f"  leads touched: {len(leads_seen)} ({sorted(leads_seen)})")
    print(f"  accounts touched: {len(accounts_seen)} ({sorted(accounts_seen)})")
    if skipped:
        print(f"  skipped (handle not in golden_leads.yaml): {skipped}")
        for h, n in skipped_handles.items():
            print(f"    {h}: {n}")

    with crm.connect() as con:
        s = crm.stats(con)
    print()
    print(f"  CRM totals: posts={s['posts']} leads={s['leads']} accounts={s['accounts']} templates={s['templates']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
