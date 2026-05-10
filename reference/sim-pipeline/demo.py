"""
Live demo runner — single-command cycle through every stage of the engine.

Reads from the live CRM state (no re-running of expensive LLM calls), but
walks through each stage with theatrical pacing so a viewer sees the
end-to-end flow as if the engine just ran.

Usage:
    python -m scripts.p2.demo                # full pacing (~5 min)
    python -m scripts.p2.demo --fast         # no pauses
    python -m scripts.p2.demo --pause 0.5    # custom pause length
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from . import crm, experiments
from ._common import REPO_ROOT


HERO = "keith_rabkin"
PAUSE_DEFAULT = 2.0
TYPE_DELAY = 0.0  # set to e.g. 0.005 for typewriter effect

# ANSI color codes
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"
RED = "\033[31m"

PAUSE_LEN = PAUSE_DEFAULT


def pause(seconds: float | None = None) -> None:
    s = PAUSE_LEN if seconds is None else seconds
    if s > 0:
        time.sleep(s)


def banner(text: str, color: str = CYAN) -> None:
    bar = "═" * 78
    print(f"\n{color}{bar}{RESET}")
    print(f"{color}{BOLD}  {text}{RESET}")
    print(f"{color}{bar}{RESET}\n")


def stage(num: int, name: str, description: str) -> None:
    print()
    print(f"{CYAN}┌─ STAGE {num}: {BOLD}{name}{RESET}{CYAN} {'─' * (60 - len(name))}{RESET}")
    print(f"{CYAN}│{RESET} {DIM}{description}{RESET}")
    print(f"{CYAN}└{'─' * 76}{RESET}")
    print()
    pause(0.8)


def kv(key: str, value: str, indent: int = 2) -> None:
    pad = " " * indent
    print(f"{pad}{DIM}{key}:{RESET} {value}")


def info(line: str, indent: int = 2) -> None:
    pad = " " * indent
    print(f"{pad}{line}")


def emph(line: str, indent: int = 2) -> None:
    pad = " " * indent
    print(f"{pad}{BOLD}{YELLOW}{line}{RESET}")


def truncate(text: str, n: int) -> str:
    if not text:
        return ""
    if len(text) <= n:
        return text
    return text[:n].rstrip() + "…"


def show_file_excerpt(path: Path, max_lines: int = 40, label: str | None = None) -> None:
    if not path.exists():
        info(f"{DIM}(file not found: {path}){RESET}")
        return
    if label:
        print(f"  {DIM}── {label} ── ({path.relative_to(REPO_ROOT)}){RESET}")
    lines = path.read_text().split("\n")
    showing = lines[:max_lines]
    for line in showing:
        print(f"  {line}")
    if len(lines) > max_lines:
        print(f"  {DIM}… ({len(lines) - max_lines} more lines){RESET}")
    print()


# ───────────────────────────────────────────────────────────────────────────
# STAGES

def opening() -> None:
    banner("SIM — AUTONOMOUS OUTBOUND ENGINE  ·  LIVE DEMO", color=MAGENTA)
    info(f"{DIM}{datetime.now().isoformat(timespec='seconds')}{RESET}")
    print()
    info("This walkthrough cycles through every stage of the engine on real")
    info("prospects. No SDRs in the loop. No human writes a single message.")
    info("The engine targets, composes, sends, learns.")
    print()
    crm.init()
    with crm.connect() as con:
        s = crm.stats(con)
    kv("Live state", f"{s['accounts']} accounts · {s['leads']} leads · "
                     f"{s['posts']} posts · {s['triggers']} triggers")
    pause(2.5)


def stage_1_scrape() -> None:
    stage(1, "INGEST", "Pull public posts from LinkedIn, X, podcasts, news")
    crm.init()
    with crm.connect() as con:
        n_posts = con.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
        n_leads = con.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
        n_accts = con.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        ch_dist = con.execute(
            "SELECT channel, COUNT(*) n FROM posts GROUP BY channel ORDER BY n DESC"
        ).fetchall()
        # Most recent post
        row = con.execute(
            "SELECT * FROM posts ORDER BY posted_at DESC LIMIT 1"
        ).fetchone()

    info(f"{GREEN}✓{RESET} Pulled {BOLD}{n_posts}{RESET} posts across "
         f"{BOLD}{n_leads}{RESET} leads + {BOLD}{n_accts}{RESET} accounts")
    print()
    info(f"{DIM}Channel distribution:{RESET}")
    for r in ch_dist:
        info(f"  · {r['channel']:<10} {r['n']:>3} posts")
    print()
    if row:
        info(f"{DIM}Sample post:{RESET}")
        info(f"  {DIM}from{RESET} {row['author_handle'] or '?'}  ·  "
             f"{DIM}at{RESET} {(row['posted_at'] or '')[:10]}  ·  "
             f"{DIM}channel{RESET} {row['channel']}")
        info(f"  {DIM}\"{truncate(row['text'], 200)}\"{RESET}")
    pause()


def stage_2_understand() -> None:
    stage(2, "UNDERSTAND",
          "Synthesize comprehension doc per entity — what they're building, role, stage")
    crm.init()
    with crm.connect() as con:
        rows = con.execute(
            "SELECT lead_id, name, sim_alignment_score, LENGTH(understanding_md) as len "
            "FROM leads WHERE understanding_md IS NOT NULL ORDER BY sim_alignment_score DESC"
        ).fetchall()
    info(f"{GREEN}✓{RESET} Synthesized comprehension doc for {BOLD}{len(rows)}{RESET} entities")
    print()
    print(f"  {BOLD}lead{RESET}                          {BOLD}alignment{RESET}   {BOLD}doc size{RESET}")
    print(f"  {DIM}{'─' * 60}{RESET}")
    for r in rows[:10]:
        align = r['sim_alignment_score'] or 0.0
        print(f"  {r['name'][:25]:<25}     {align:>6.3f}      {r['len'] or 0:>5} chars")
    print()
    info(f"{DIM}Each understanding doc is then embedded in 384-dim space (BAAI/bge-small-en-v1.5){RESET}")
    info(f"{DIM}Same model + same space as Sim's corpus chunks — cosine similarity directly compares them{RESET}")
    print()
    info(f"{YELLOW}>>{RESET} Drilling into hero entity:  {BOLD}Keith Rabkin (PandaDoc){RESET}")
    print()
    show_file_excerpt(REPO_ROOT / "understand" / f"lead__{HERO}.md", max_lines=30,
                       label="Keith Rabkin's synthesized understanding")
    pause()


def stage_3_score() -> None:
    stage(3, "SCORE",
          "Per-post intent score = mean top-5 cosine to Sim corpus (deterministic, 0-10)")
    crm.init()
    with crm.connect() as con:
        rows = con.execute(
            "SELECT * FROM posts WHERE lead_id=? ORDER BY intent_score DESC LIMIT 5",
            (HERO,)
        ).fetchall()
    info(f"{GREEN}✓{RESET} Top-5 scoring posts for Keith Rabkin (out of all his posts):")
    print()
    for r in rows:
        score = r['intent_score'] or 0
        bar = "█" * score + "░" * (10 - score)
        title = r['title'] or truncate(r['text'] or '', 60)
        print(f"  {GREEN}{bar}{RESET}  {BOLD}{score}/10{RESET}   {DIM}{(r['posted_at'] or '')[:10]}{RESET}  {title[:50]}")
    print()
    # Show the top corpus match for the highest-scored post
    top = rows[0] if rows else None
    if top and top['top_corpus_match_md']:
        info(f"{DIM}Top corpus matches for the highest-scoring post:{RESET}")
        for line in top['top_corpus_match_md'].split("\n")[:6]:
            info(f"  {line}")
    print()
    info(f"{DIM}The score is deterministic — a vector dot product, not LLM judgment.{RESET}")
    info(f"{DIM}LLM still writes the rationale per post for the audit trail.{RESET}")
    pause()


def stage_4_classify() -> None:
    stage(4, "CLASSIFY",
          "Decision urgency × themes × note hook  (action-shape selector, not targeting)")
    crm.init()
    with crm.connect() as con:
        rows = con.execute(
            "SELECT name, decision_urgency, icp_themes FROM leads "
            "WHERE decision_urgency IS NOT NULL AND decision_urgency != '' "
            "ORDER BY CASE decision_urgency "
            " WHEN 'active_build' THEN 0 WHEN 'building_soon' THEN 1 "
            " WHEN 'philosophical' THEN 2 ELSE 3 END"
        ).fetchall()
    icon = {
        "active_build": "🚧",
        "building_soon": "📋",
        "philosophical": "💭",
        "quiet": "💤",
    }
    info(f"{GREEN}✓{RESET} Classified decision urgency for {BOLD}{len(rows)}{RESET} leads")
    print()
    for r in rows:
        u = r['decision_urgency']
        try:
            themes = json.loads(r['icp_themes'] or '[]')
        except (ValueError, TypeError):
            themes = []
        theme = themes[0] if themes else ''
        print(f"  {icon.get(u, '·')}  {BOLD}{r['name'][:24]:<24}{RESET}  "
              f"{u:<16}  {DIM}{theme[:38]}{RESET}")
    print()
    info(f"{DIM}Urgency drives action shape:{RESET}")
    info(f"  active_build  → ship Mothership prompt (runnable workflow)")
    info(f"  building_soon → workflow OR substantive note")
    info(f"  philosophical → discovery question on their thesis")
    info(f"  quiet         → no outreach")
    pause()


def stage_5_match() -> None:
    stage(5, "MATCH",
          "Cosine match: entity understanding + posts vs Sim corpus → top primitives")
    crm.init()
    with crm.connect() as con:
        candidates = crm.cosine_match_entity_to_corpus(con, "lead", HERO, top_k=8, min_cosine=0.50)
    info(f"{GREEN}✓{RESET} Top Sim primitives for Keith Rabkin (cosine to his understanding embedding):")
    print()
    for c in candidates[:6]:
        kind = c['kind']
        cos = c['cosine_score']
        bar_len = int((cos - 0.5) * 30)
        bar = "█" * bar_len
        print(f"  {GREEN}{bar:<15}{RESET}  {cos:.3f}  {DIM}[{kind}]{RESET}  {c['name'][:50]}")
    print()
    info(f"{DIM}These are the Sim building-blocks the engine will use to compose Keith's workflow.{RESET}")
    pause()


def stage_6_triggers() -> None:
    stage(6, "TRIGGERS",
          "Fire on threshold crossings — per-post intent ≥9 OR cumulative ≥18")
    crm.init()
    with crm.connect() as con:
        triggers = con.execute(
            "SELECT t.*, "
            " CASE WHEN t.entity_type='lead' THEN (SELECT name FROM leads WHERE lead_id=t.entity_id) "
            "      ELSE (SELECT name FROM accounts WHERE account_id=t.entity_id) END as name "
            "FROM triggers t ORDER BY t.fired_at_post_time DESC"
        ).fetchall()
    info(f"{RED}🔔{RESET} {BOLD}{len(triggers)} triggers fired{RESET}  "
         f"{DIM}(engine queues next action automatically — no human review for non-high-stakes){RESET}")
    print()
    for t in triggers:
        ts = (t['fired_at_post_time'] or '')[:10]
        ttype = t['trigger_type']
        print(f"  {RED}🔔{RESET}  {ts}  {BOLD}{t['name'][:25]:<25}{RESET}  "
              f"{YELLOW}{ttype:<22}{RESET}  {DIM}{truncate(t['evidence_summary'] or '', 50)}{RESET}")
    pause()


def stage_7_generate() -> None:
    stage(7, "GENERATE",
          "Compose the Mothership prompt — anchor + breadth from prospect's posts")
    info("On trigger fire, the engine:")
    info("  1. Picks the anchor post (the system Keith built)")
    info("  2. Picks 2-3 supporting posts (his adjacent concerns)")
    info("  3. Pulls closest Sim primitives by cosine")
    info(f"  4. {BOLD}Thompson-samples the composition arm{RESET} (anchor_only vs anchor+breadth)")
    info("  5. LLM composes the runnable workflow spec")
    pause(1.5)
    print()
    # Show the experiment arm chosen for this entity
    audit_path = REPO_ROOT / "golden" / HERO / "mothership_prompt.output.json"
    if audit_path.exists():
        try:
            audit = json.loads(audit_path.read_text())
            arm = audit.get("experiment_prompt_composition_arm", "?")
            info(f"  {YELLOW}>>{RESET} Thompson-sampled composition arm for Keith: {BOLD}{arm}{RESET}")
            info(f"  {YELLOW}>>{RESET} Generation: {audit.get('elapsed_seconds', '?')}s, "
                 f"{audit.get('input_tokens', '?')}→{audit.get('output_tokens', '?')} tokens")
        except (ValueError, json.JSONDecodeError):
            pass
    print()
    info(f"{BOLD}{MAGENTA}>>>  COMPOSED ARTIFACT (this is what gets sent — paste-ready):{RESET}")
    print()
    show_file_excerpt(REPO_ROOT / "golden" / HERO / "mothership_prompt.md", max_lines=80,
                       label="Keith Rabkin's Mothership prompt")
    pause(3)


def stage_8_send() -> None:
    stage(8, "SEND",
          "Engine sends autonomously — channel + timing + opener Thompson-sampled")
    crm.init()
    with crm.connect() as con:
        row = con.execute("SELECT name, icp_note_hook FROM leads WHERE lead_id=?", (HERO,)).fetchone()
    name = row['name'] if row else HERO
    hook = (row['icp_note_hook'] if row else '') or "(no hook generated — quiet urgency)"

    info(f"{GREEN}✓{RESET} Outbound message ready for {BOLD}{name}{RESET}:")
    print()
    print(f"  {DIM}┌──────────────────────────────────────────────────────────────────────┐{RESET}")
    print(f"  {DIM}│{RESET} To: {name}")
    print(f"  {DIM}│{RESET} Channel: linkedin  {DIM}(Thompson-sampled){RESET}")
    print(f"  {DIM}│{RESET} Touch: day_0  {DIM}(Thompson-sampled){RESET}")
    print(f"  {DIM}├──────────────────────────────────────────────────────────────────────┤{RESET}")
    for line in (hook or "").split("\n"):
        for chunk in [line[i:i+68] for i in range(0, max(len(line), 1), 68)]:
            print(f"  {DIM}│{RESET} {chunk}")
    print(f"  {DIM}│{RESET}")
    print(f"  {DIM}│{RESET} Built this in Sim — fork link runs immediately on mock data:")
    print(f"  {DIM}│{RESET} sim.ai/fork/abc123")
    print(f"  {DIM}└──────────────────────────────────────────────────────────────────────┘{RESET}")
    print()
    info(f"{DIM}Engine tracks: delivered → opened → replied → fork_clicked → activated → paid{RESET}")
    info(f"{DIM}Each event flows back as posterior updates to the experiments.{RESET}")
    pause()


def stage_9_experiments() -> None:
    stage(9, "EXPERIMENTS",
          "9 pre-registered multi-arm experiments. Posteriors update from outcomes.")
    exps = experiments.load_experiments()
    rows = experiments.posteriors()
    by_id: dict[str, list[dict]] = {}
    for r in rows:
        by_id.setdefault(r["experiment_id"], []).append(r)
    info(f"{GREEN}✓{RESET} {BOLD}{len(exps)}{RESET} experiments registered  ·  "
         f"{BOLD}{len(rows)}{RESET} arms tracked")
    print()
    for exp in exps:
        layer = exp.get('layer', '?')
        eid = exp['id']
        n_arms = len(by_id.get(eid, []))
        default = exp.get('current_default', '')
        default_str = f"  {DIM}default: {default}{RESET}" if default else ""
        print(f"  {YELLOW}●{RESET} {BOLD}{eid:<28}{RESET}  {DIM}[{layer}]{RESET}  "
              f"{n_arms} arms{default_str}")
    print()
    info(f"{DIM}Today posteriors are at α=1, β=1 priors (uninformative). Once outreach{RESET}")
    info(f"{DIM}runs, every event (reply, fork-click, activation) updates a posterior{RESET}")
    info(f"{DIM}automatically. After 1-2K touches per ICP segment, the system has{RESET}")
    info(f"{DIM}empirically converged on the best arm per segment.{RESET}")
    pause()


def stage_10_dashboard() -> None:
    stage(10, "DASHBOARD",
          "The audit surface — what a human sees if they monitor the engine")
    console_path = REPO_ROOT / "CONSOLE.md"
    show_file_excerpt(console_path, max_lines=30,
                       label="CRM dashboard (auto-rendered from SQLite)")
    pause()


def stage_11_revenue() -> None:
    stage(11, "REVENUE",
          "What this earns Sim in 2026")
    print(f"  {BOLD}ACV anchors:{RESET}")
    info(f"  · YC companies:      5 users at $500/mo total      = {BOLD}$6K ACV{RESET}")
    info(f"  · Mid-market orgs:   50 users × $100/user/mo       = {BOLD}$60K ACV{RESET}")
    print()
    print(f"  {BOLD}Combined Year-1 (10K YC + 5K mid-market touches, +30% expansion):{RESET}")
    print()
    print(f"    Conservative:  YC $54K + MM $120K + exp = {BOLD}$226K{RESET}")
    print(f"    {GREEN}Mid:           YC $204K + MM $600K + exp = {BOLD}$1.05M{RESET}{RESET}")
    print(f"    Aggressive:    YC $600K + MM $2.1M + exp = {BOLD}$3.51M{RESET}")
    print()
    print(f"  {BOLD}Scale-up (2× volume — 25K YC + 10K mid-market):{RESET}")
    print()
    print(f"    Conservative:  {BOLD}$488K{RESET}")
    print(f"    {GREEN}Mid:           {BOLD}$2.22M{RESET}{RESET}")
    print(f"    Aggressive:    {BOLD}$7.41M{RESET}")
    print()
    info(f"{DIM}Year-2 NRR on the YC cohort hits 130-150% as those companies scale.{RESET}")
    info(f"{DIM}Mid-market is the Y1 ARR engine; YC is the Y2 multiplier.{RESET}")
    pause()


def closing() -> None:
    banner("DEMO COMPLETE", color=GREEN)
    info(f"{BOLD}What you just saw:{RESET}")
    info("  · An autonomous outbound engine cycle through 11 stages")
    info("  · No SDR in the loop. No human writes a single message.")
    info("  · Every decision in every stage is a Thompson-sampled experiment arm")
    info("  · The cold artifact is a runnable Sim workflow, not copy")
    print()
    info(f"{BOLD}Re-run:{RESET}  {CYAN}python -m scripts.p2.demo{RESET}  (full pacing)")
    info(f"{BOLD}Or:{RESET}      {CYAN}python -m scripts.p2.demo --fast{RESET}  (no pauses)")
    info(f"{BOLD}Static:{RESET}  see {CYAN}README.md{RESET} for the demo output rendered as docs")
    print()


# ───────────────────────────────────────────────────────────────────────────

def main() -> int:
    global PAUSE_LEN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast", action="store_true", help="no pauses between stages")
    parser.add_argument("--pause", type=float, default=PAUSE_DEFAULT,
                        help=f"pause length in seconds (default: {PAUSE_DEFAULT})")
    args = parser.parse_args()

    if args.fast:
        PAUSE_LEN = 0.0
    else:
        PAUSE_LEN = args.pause

    try:
        opening()
        stage_1_scrape()
        stage_2_understand()
        stage_3_score()
        stage_4_classify()
        stage_5_match()
        stage_6_triggers()
        stage_7_generate()
        stage_8_send()
        stage_9_experiments()
        stage_10_dashboard()
        stage_11_revenue()
        closing()
    except KeyboardInterrupt:
        print(f"\n{YELLOW}[demo interrupted]{RESET}")
        return 130

    return 0


if __name__ == "__main__":
    sys.exit(main())
