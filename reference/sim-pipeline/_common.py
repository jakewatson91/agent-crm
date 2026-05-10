"""
Shared helpers for the P2 step scripts.

- Prompt loading from prompts/<step>.md
- Fewshot loading from fewshots/<step>.jsonl with most-recent-N slicing
- Markdown write with .original.md snapshot
- Hash compare for edit detection
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
PROMPTS_DIR = REPO_ROOT / "prompts"
FEWSHOTS_DIR = REPO_ROOT / "fewshots"


def load_env() -> None:
    """Load .env.local once."""
    load_dotenv(ENV_PATH, override=True)


def load_prompt(step: str) -> str:
    """Read prompts/<step>.md."""
    path = PROMPTS_DIR / f"{step}.md"
    if not path.exists():
        raise FileNotFoundError(f"prompt missing: {path}")
    return path.read_text()


def load_fewshots(step: str, max_examples: int = 5) -> list[dict]:
    """Read up to max_examples most-recent fewshot tuples from fewshots/<step>.jsonl.

    Each line: {"input": str, "original_output": str, "user_edit": str}
    Returns most-recent first.
    """
    path = FEWSHOTS_DIR / f"{step}.jsonl"
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out[-max_examples:][::-1]


def append_fewshot(step: str, *, input: str, original_output: str, user_edit: str) -> None:
    FEWSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    path = FEWSHOTS_DIR / f"{step}.jsonl"
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps({
            "input": input,
            "original_output": original_output,
            "user_edit": user_edit,
        }, ensure_ascii=False) + "\n")


def format_fewshots_block(examples: list[dict]) -> str:
    """Format fewshots as a system-prompt-prefixable block."""
    if not examples:
        return ""
    parts = ["EXAMPLES OF GOOD OUTPUT (LEARNED FROM USER EDITS):", ""]
    for i, ex in enumerate(examples, 1):
        parts.append(f"--- Example {i} ---")
        parts.append("Input:")
        parts.append(ex.get("input", "")[:2000])
        parts.append("")
        parts.append("Output (corrected by user):")
        parts.append(ex.get("user_edit", ""))
        parts.append("")
    parts.append("END OF EXAMPLES.")
    parts.append("")
    return "\n".join(parts)


def write_md_with_original(out_dir: Path, slug: str, content: str, *, force: bool = False) -> Path:
    """Write content to <out_dir>/<slug>.md and a snapshot to .original.md.

    If <slug>.md already exists and we're not forcing, we DO NOT touch the user's
    edited copy; we still update .original.md if it doesn't exist or if --force.

    Returns the path written.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"{slug}.md"
    orig_path = out_dir / f"{slug}.original.md"

    if md_path.exists() and not force:
        # Don't overwrite user's edits. Make sure .original exists; if not, seed it.
        if not orig_path.exists():
            orig_path.write_text(md_path.read_text())
        return md_path

    md_path.write_text(content)
    orig_path.write_text(content)
    return md_path


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def detect_edit(out_dir: Path, slug: str) -> tuple[str, str] | None:
    """If <slug>.md differs from <slug>.original.md, return (original, edited).
    Else None.
    """
    md_path = out_dir / f"{slug}.md"
    orig_path = out_dir / f"{slug}.original.md"
    if not md_path.exists() or not orig_path.exists():
        return None
    md = md_path.read_text()
    orig = orig_path.read_text()
    if hash_text(md) == hash_text(orig):
        return None
    return orig, md
