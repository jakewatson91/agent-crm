/**
 * compress(html_or_text) — token-efficient text for LLM consumption.
 *
 * Purpose: every connector that fetches a web page or email body currently
 * pipes nearly-raw markup into the next LLM call. HTML attributes, inline
 * scripts, and full-length tracking URLs eat tokens for no signal. compress()
 * runs three passes:
 *
 *   1. HTML→Markdown — drop boilerplate (script/style/head/svg/noscript),
 *      keep headings, lists, links, paragraphs, basic emphasis.
 *   2. URL collapse  — long URLs become [ref:N] markers; originals go in a
 *      sidecar `refs` array so provenance/CiteChain can resolve them later.
 *   3. Whitespace dedup — collapse runs of blank lines / spaces.
 *
 * Optional fourth pass: when the post-compression length still exceeds
 * `llm_summary_above_tokens`, call an LLM to summarise. Off by default —
 * trading tokens for an extra round trip only pays off on really big inputs.
 *
 * No external deps. Tokenization is a char/4 heuristic, the same one OpenAI
 * cites for English text; off by ~10% but that's fine for routing decisions.
 *
 * Mutli-byte text (CJK, emoji, accented Latin) passes through unmodified.
 */

export interface CompressOptions {
  /** Skip URL collapsing for short URLs. Default 32. */
  url_min_length?: number;
  /** Hard upper bound on output chars after compression. 0 = no cap. */
  max_chars?: number;
  /** Estimated token threshold above which to run an LLM summary pass. 0 = off. */
  llm_summary_above_tokens?: number;
  /** Caller-provided summariser. Required if llm_summary_above_tokens > 0. */
  summarise?: (text: string) => Promise<string>;
}

export interface UrlRef {
  id: number;
  url: string;
}

export interface CompressResult {
  text: string;
  refs: UrlRef[];
  /** Estimated tokens in `text` (post-compression). */
  token_estimate: number;
  /** True if an LLM summary pass ran. */
  llm_summarised: boolean;
  /** Char counts before / after each pass — handy for cost dashboards. */
  stats: {
    input_chars: number;
    after_markdown_chars: number;
    after_urls_chars: number;
    output_chars: number;
  };
}

const BOILERPLATE_TAGS = /<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SELF_CLOSING_NOISE = /<(meta|link|input|img|br|hr|source|track|area|base|col|embed|param|wbr)\b[^>]*\/?\s*>/gi;

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&#39;': "'", '&#x27;': "'", '&hellip;': '…', '&mdash;': '—',
  '&ndash;': '–', '&rsquo;': "'", '&lsquo;': "'", '&rdquo;': '"', '&ldquo;': '"',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

/**
 * Convert HTML to a markdown-ish plain text. Not a complete markdown
 * implementation; the goal is "token-efficient text an LLM can read,"
 * not "round-trippable markdown."
 */
function htmlToMarkdown(html: string): string {
  let s = html;

  // 1. Strip boilerplate blocks entirely.
  s = s.replace(BOILERPLATE_TAGS, '');
  s = s.replace(HTML_COMMENT, '');
  s = s.replace(SELF_CLOSING_NOISE, '');

  // 2. Block-level structure → markdown.
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  s = s.replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');
  s = s.replace(/<\/?(p|div|section|article|header|footer|main|aside)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  s = s.replace(/<(code|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi, '`$2`');

  // 3. Inline emphasis. Strip everything else.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // 4. Links: <a href="X">Y</a> → [Y](X). URL collapse happens in the next pass.
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = String(text).replace(/<[^>]+>/g, '').trim();
    return t ? `[${t}](${href})` : `(${href})`;
  });

  // 5. Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, '');

  // 6. Decode entities last so we don't accidentally re-interpret the result.
  s = decodeEntities(s);
  return s;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s)\]<>"']+/g;

function collapseUrls(text: string, min_length: number): { out: string; refs: UrlRef[] } {
  const refs: UrlRef[] = [];
  const byUrl = new Map<string, number>();
  const out = text.replace(URL_PATTERN, (url) => {
    if (url.length < min_length) return url;
    let id = byUrl.get(url);
    if (id === undefined) {
      id = refs.length + 1;
      byUrl.set(url, id);
      refs.push({ id, url });
    }
    return `[ref:${id}]`;
  });
  return { out, refs };
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function looksLikeHtml(s: string): boolean {
  return /<\/?(html|body|p|div|span|a|h[1-6]|ul|ol|li|br|table|tr|td|article|section)\b/i.test(s.slice(0, 4000));
}

export async function compress(input: string, opts: CompressOptions = {}): Promise<CompressResult> {
  const input_chars = input.length;
  const url_min_length = opts.url_min_length ?? 32;
  const max_chars = opts.max_chars ?? 0;
  const llm_summary_above_tokens = opts.llm_summary_above_tokens ?? 0;

  let text = looksLikeHtml(input) ? htmlToMarkdown(input) : input;
  const after_markdown_chars = text.length;

  const { out, refs } = collapseUrls(text, url_min_length);
  text = out;
  const after_urls_chars = text.length;

  text = collapseWhitespace(text);

  if (max_chars > 0 && text.length > max_chars) {
    text = text.slice(0, max_chars);
  }

  let llm_summarised = false;
  let token_estimate = estimateTokens(text);
  if (llm_summary_above_tokens > 0 && token_estimate > llm_summary_above_tokens && opts.summarise) {
    const summary = await opts.summarise(text);
    if (summary && summary.length < text.length) {
      text = summary;
      token_estimate = estimateTokens(text);
      llm_summarised = true;
    }
  }

  return {
    text,
    refs,
    token_estimate,
    llm_summarised,
    stats: {
      input_chars,
      after_markdown_chars,
      after_urls_chars,
      output_chars: text.length,
    },
  };
}
