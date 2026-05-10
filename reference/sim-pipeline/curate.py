"""
Step 0 — curate the golden source-of-truth.

For each lead in config/golden_leads.yaml:
  - Ensure account row (domain-keyed)
  - Ensure lead row (linked to account)
  - Deep-scrape last N days across configured channels
  - Save posts to golden/<lead_id>/posts.json (committable, reproducible)
  - Insert into CRM posts table (lead_id + account_id both set)
  - News mentions about the company (not the person) attach to account directly

Channels handled:
  - linkedin: Exa with linkedin.com domain + name + handle
  - x: Exa with x.com domain + handle
  - podcast: Exa broad — name + "podcast" + recent
  - news: Exa with company name + verbs (raises, launches, partners, etc.)
  - hn: Algolia by handle

Usage:
    python -m scripts.p2.curate
    python -m scripts.p2.curate --lead emir_atli
    python -m scripts.p2.curate --since 30d
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import yaml

from . import crm
from ._common import REPO_ROOT, load_env

CONFIG_PATH = REPO_ROOT / "config" / "golden_leads.yaml"
GOLDEN_DIR = REPO_ROOT / "golden"

HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


@dataclass
class GoldenPost:
    post_id: str
    lead_id: str        # may be empty for account-level posts (news about company)
    account_id: str
    channel: str
    url: str
    posted_at: str       # ISO; required for replay
    title: str = ""
    text: str = ""
    author_handle: str = ""
    source_query: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def post_id_from_url(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:12]


def _parse_iso_date(s: str) -> datetime | None:
    if not s:
        return None
    try:
        s = s.rstrip("Z")
        if "." in s:
            head, dot, frac = s.partition(".")
            s = f"{head}.{frac[:6]}"
        if "+" not in s and "-" not in s[10:]:
            dt = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


# ----------------------------------------------------------------------------
# Exa + HN

async def exa_search(client: httpx.AsyncClient, query: str, *,
                     num_results: int = 15,
                     include_domains: list[str] | None = None,
                     start_published: str | None = None) -> list[dict]:
    api_key = os.getenv("EXA_API_KEY", "").strip()
    if not api_key:
        return []
    body: dict = {
        "query": query,
        "type": "neural",
        "numResults": num_results,
        "contents": {"text": True, "highlights": {"numSentences": 3, "highlightsPerUrl": 3}},
    }
    if include_domains:
        body["includeDomains"] = include_domains
    if start_published:
        body["startPublishedDate"] = start_published
    try:
        r = await client.post("https://api.exa.ai/search",
                              json=body,
                              headers={"x-api-key": api_key, "Content-Type": "application/json"})
    except httpx.HTTPError as e:
        print(f"  [exa-fail] {query[:60]!r}: {e}")
        return []
    if r.status_code != 200:
        print(f"  [exa-fail] {query[:60]!r} status={r.status_code}")
        return []
    return r.json().get("results", [])


async def hn_search(client: httpx.AsyncClient, query: str, *, since_ts: int,
                    max_results: int = 10) -> list[dict]:
    try:
        r = await client.get(
            "https://hn.algolia.com/api/v1/search_by_date",
            params={
                "query": query,
                "tags": "(story,comment)",
                "numericFilters": f"created_at_i>{since_ts}",
                "hitsPerPage": max_results,
            },
            timeout=10.0,
        )
    except httpx.HTTPError:
        return []
    if r.status_code != 200:
        return []
    return r.json().get("hits", [])


# ----------------------------------------------------------------------------
# Per-channel curators

def _result_to_post(item: dict, *, lead_id: str, account_id: str, channel: str,
                    cutoff_dt: datetime, source_query: str) -> GoldenPost | None:
    url = (item.get("url") or "").strip()
    if not url:
        return None
    title = (item.get("title") or "").strip()
    text = (item.get("text") or "").strip()
    highlights = item.get("highlights") or []
    snippet = " … ".join(h.strip() for h in highlights if h)
    full_text = (text or "")[:3000]
    if highlights:
        full_text = (snippet + "\n\n" + full_text).strip()[:3000]
    if len(full_text) < 60:
        return None
    posted_at = item.get("publishedDate") or ""
    pdt = _parse_iso_date(posted_at)
    if pdt is None or pdt < cutoff_dt:
        return None
    return GoldenPost(
        post_id=post_id_from_url(url),
        lead_id=lead_id,
        account_id=account_id,
        channel=channel,
        url=url,
        posted_at=posted_at,
        title=title[:200],
        text=full_text,
        author_handle="",
        source_query=source_query,
    )


def _result_mentions_lead(item: dict, name: str, handle: str) -> bool:
    """Permissive: require ANY of name, last name, or handle in the text/URL.
    For explicit lead-targeted queries we trust Exa's neural ranking; this
    just keeps out wildly off-topic results.
    """
    haystack = " ".join([
        item.get("title") or "",
        item.get("text") or "",
        item.get("url") or "",
        " ".join(item.get("highlights") or []),
    ]).lower()
    name_l = name.lower()
    handle_l = (handle or "").lstrip("@").lower().replace("-", "").replace("_", "")
    haystack_norm = haystack.replace("-", "").replace("_", "")

    if handle_l and len(handle_l) >= 4 and handle_l in haystack_norm:
        return True
    if name_l and name_l in haystack:
        return True
    parts = [p for p in name_l.split() if len(p) > 2]
    if parts:
        # Last name alone is enough
        last = parts[-1]
        if last in haystack:
            return True
    return False


async def curate_lead(client: httpx.AsyncClient, lead_cfg: dict,
                      cutoff_dt: datetime, exa_max: int) -> list[GoldenPost]:
    lead_id = lead_cfg["lead_id"]
    name = lead_cfg["name"]
    handle = lead_cfg["handle"]
    company = lead_cfg["parent_account_name"]
    domain = lead_cfg["parent_account_domain"]
    channels = lead_cfg.get("channels") or []

    account_id = crm.domain_to_account_id(domain)
    out: list[GoldenPost] = []
    seen_urls: set[str] = set()

    iso_cutoff = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    print(f"\n  [curate] {name} ({lead_id}) at {company}")

    # 1. LinkedIn (lead-level)
    if "linkedin" in channels:
        queries = [
            f"{name} LinkedIn post",
            f"{name} {company} announcement",
            f"{handle} linkedin update",
        ]
        for q in queries:
            results = await exa_search(client, q, num_results=exa_max,
                                        include_domains=["linkedin.com"],
                                        start_published=iso_cutoff)
            for item in results:
                if (item.get("url") or "") in seen_urls:
                    continue
                if not _result_mentions_lead(item, name, handle):
                    continue
                p = _result_to_post(item, lead_id=lead_id, account_id=account_id,
                                     channel="linkedin", cutoff_dt=cutoff_dt,
                                     source_query=f"linkedin: {q}")
                if p:
                    seen_urls.add(p.url)
                    out.append(p)

    # 2. X / Twitter (lead-level)
    if "x" in channels:
        queries = [
            f"{handle} on x.com {company}",
            f"{name} twitter posts {company}",
        ]
        for q in queries:
            results = await exa_search(client, q, num_results=exa_max,
                                        include_domains=["x.com", "twitter.com"],
                                        start_published=iso_cutoff)
            for item in results:
                if (item.get("url") or "") in seen_urls:
                    continue
                if not _result_mentions_lead(item, name, handle):
                    continue
                p = _result_to_post(item, lead_id=lead_id, account_id=account_id,
                                     channel="x", cutoff_dt=cutoff_dt,
                                     source_query=f"x: {q}")
                if p:
                    seen_urls.add(p.url)
                    out.append(p)

    # 3. Podcast appearances (lead-level, broad search)
    if "podcast" in channels:
        queries = [
            f"{name} podcast {company}",
            f"{name} interview {company}",
            f"{name} {company} CRO podcast",
        ]
        for q in queries:
            results = await exa_search(client, q, num_results=exa_max,
                                        start_published=iso_cutoff)
            for item in results:
                if (item.get("url") or "") in seen_urls:
                    continue
                if not _result_mentions_lead(item, name, handle):
                    continue
                p = _result_to_post(item, lead_id=lead_id, account_id=account_id,
                                     channel="podcast", cutoff_dt=cutoff_dt,
                                     source_query=f"podcast: {q}")
                if p:
                    seen_urls.add(p.url)
                    out.append(p)

    # 4. Substack (lead-level if author writes there)
    if "substack" in channels:
        queries = [
            f"{name} {company} substack post",
            f"{handle} newsletter substack",
        ]
        for q in queries:
            results = await exa_search(client, q, num_results=exa_max,
                                        include_domains=["substack.com"],
                                        start_published=iso_cutoff)
            for item in results:
                if (item.get("url") or "") in seen_urls:
                    continue
                if not _result_mentions_lead(item, name, handle):
                    continue
                p = _result_to_post(item, lead_id=lead_id, account_id=account_id,
                                     channel="substack", cutoff_dt=cutoff_dt,
                                     source_query=f"substack: {q}")
                if p:
                    seen_urls.add(p.url)
                    out.append(p)

    # 5. Company news (account-level — lead_id stays "" so post attaches to account)
    if "news" in channels:
        queries = [
            f"{company} announcement",
            f"{company} raises funding",
            f"{company} launches new product",
            f"{company} hires",
            f"{company} partners",
        ]
        for q in queries:
            results = await exa_search(client, q, num_results=exa_max,
                                        start_published=iso_cutoff)
            for item in results:
                if (item.get("url") or "") in seen_urls:
                    continue
                # Filter: result must mention the company name
                hay = " ".join([item.get("title") or "", item.get("text") or "",
                                 item.get("url") or ""]).lower()
                if company.lower() not in hay:
                    continue
                p = _result_to_post(item, lead_id="", account_id=account_id,
                                     channel="news", cutoff_dt=cutoff_dt,
                                     source_query=f"news: {q}")
                if p:
                    seen_urls.add(p.url)
                    out.append(p)

    # 6. HN
    if "hn" in channels:
        since_ts = int(cutoff_dt.timestamp())
        for q in (name, handle, company):
            if not q:
                continue
            hits = await hn_search(client, q, since_ts=since_ts)
            for h in hits:
                url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID', '')}"
                if url in seen_urls:
                    continue
                title = h.get("title") or h.get("story_title") or ""
                text = h.get("story_text") or h.get("comment_text") or ""
                text = re.sub(r"<[^>]+>", "", text)
                if len(text) < 60:
                    continue
                created = h.get("created_at_i") or 0
                if not created:
                    continue
                pdt = datetime.fromtimestamp(created, tz=timezone.utc)
                if pdt < cutoff_dt:
                    continue
                # Lead-level if HN author handle matches; account-level otherwise
                hn_author = (h.get("author") or "").lower()
                attach_lead = lead_id if (handle and handle.lower() in hn_author) else ""
                p = GoldenPost(
                    post_id=post_id_from_url(url),
                    lead_id=attach_lead,
                    account_id=account_id,
                    channel="hn",
                    url=url,
                    posted_at=pdt.isoformat(),
                    title=title[:200],
                    text=text[:3000],
                    author_handle=h.get("author") or "",
                    source_query=f"hn: {q}",
                )
                seen_urls.add(url)
                out.append(p)

    print(f"    found {len(out)} posts across channels")
    by_ch: dict[str, int] = {}
    for p in out:
        by_ch[p.channel] = by_ch.get(p.channel, 0) + 1
    for ch, n in sorted(by_ch.items(), key=lambda x: -x[1]):
        print(f"      {ch:<10} {n}")
    return out


# ----------------------------------------------------------------------------
# Driver

async def run(config: dict, only_lead: str | None) -> int:
    lookback = int(config["defaults"]["lookback_days"])
    exa_max = int(config["defaults"]["exa_max_per_query"])
    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=lookback)

    leads = config["leads"]
    if only_lead:
        leads = [l for l in leads if l["lead_id"] == only_lead]
        if not leads:
            print(f"ERROR: no lead with lead_id={only_lead!r}")
            return 2

    print(f"[curate] {len(leads)} leads, lookback {lookback}d, cutoff {cutoff_dt.isoformat()}")

    crm.init()
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for lead_cfg in leads:
            posts = await curate_lead(client, lead_cfg, cutoff_dt, exa_max)

            # Save golden file
            lead_dir = GOLDEN_DIR / lead_cfg["lead_id"]
            lead_dir.mkdir(parents=True, exist_ok=True)
            (lead_dir / "posts.json").write_text(
                json.dumps([p.to_dict() for p in posts], indent=2)
            )

            # Persist to CRM
            account_id = crm.domain_to_account_id(lead_cfg["parent_account_domain"])
            with crm.connect() as con:
                crm.upsert_account(
                    con,
                    account_id=account_id,
                    name=lead_cfg["parent_account_name"],
                    domain=lead_cfg["parent_account_domain"],
                )
                crm.upsert_lead(
                    con,
                    lead_id=lead_cfg["lead_id"],
                    name=lead_cfg["name"],
                    channel=(lead_cfg.get("channels") or ["linkedin"])[0],
                    handle=lead_cfg["handle"],
                    parent_account_id=account_id,
                )
                for p in posts:
                    crm.upsert_post(
                        con,
                        post_id=p.post_id,
                        lead_id=p.lead_id or None,
                        account_id=p.account_id,
                        channel=p.channel,
                        url=p.url,
                        author_handle=p.author_handle,
                        posted_at=p.posted_at,
                        title=p.title,
                        text=p.text,
                        raw={"source_query": p.source_query},
                    )
                con.commit()

    # Summary stats + log decision
    with crm.connect() as con:
        s = crm.stats(con)
        crm.log_decision(con, action="curate",
                          summary=f"curated {len(leads)} leads, lookback {lookback}d, "
                                  f"posts now {s['posts']}",
                          metadata={"lookback_days": lookback, "leads": [l['lead_id'] for l in leads]})
        con.commit()
    print()
    print(f"[curate] CRM totals:")
    for k in ("accounts", "leads", "posts", "templates"):
        print(f"    {k:<20} {s[k]}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lead", default=None, help="curate a single lead_id")
    parser.add_argument("--since", default=None, help="override lookback_days (e.g. 30d)")
    parser.add_argument("--config", default=str(CONFIG_PATH), type=Path)
    args = parser.parse_args()

    load_env()
    if not os.getenv("EXA_API_KEY"):
        print("ERROR: EXA_API_KEY not set")
        return 2
    if not args.config.exists():
        print(f"ERROR: config not found: {args.config}")
        return 2

    config = yaml.safe_load(args.config.read_text())
    if args.since:
        m = re.match(r"^(\d+)d$", args.since)
        if m:
            config["defaults"]["lookback_days"] = int(m.group(1))

    return asyncio.run(run(config, args.lead))


if __name__ == "__main__":
    sys.exit(main())
