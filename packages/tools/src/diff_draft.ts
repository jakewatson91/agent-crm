/**
 * Paragraph-level diff between an original drafted email body and the human-
 * edited final version. The drafter always builds the body as a handful of
 * short paragraphs separated by blank lines (see buildDrafterDecision), so
 * diffing at that granularity is both simpler than a word-diff library and
 * lines up with the email's own structure (subject / accusation-audit /
 * problem-statement / one-liner / ask).
 */

const MAX_PARAGRAPH_CHARS = 200;

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function truncate(s: string): string {
  return s.length > MAX_PARAGRAPH_CHARS ? `${s.slice(0, MAX_PARAGRAPH_CHARS)}…` : s;
}

export interface ParagraphDiff {
  from: string;
  to: string;
}

/**
 * Returns only the paragraphs that changed. If the paragraph count differs
 * (a paragraph was added/removed), falls back to a single from/to pair
 * comparing the two full bodies rather than attempting real alignment.
 */
export function diffDraftBody(original: string, final: string): ParagraphDiff[] {
  const a = splitParagraphs(original ?? '');
  const b = splitParagraphs(final ?? '');

  if (a.length !== b.length) {
    return original.trim() === final.trim() ? [] : [{ from: truncate(original.trim()), to: truncate(final.trim()) }];
  }

  const diffs: ParagraphDiff[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diffs.push({ from: truncate(a[i]), to: truncate(b[i]) });
  }
  return diffs;
}
