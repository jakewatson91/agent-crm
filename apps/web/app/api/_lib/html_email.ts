/**
 * Email-HTML helpers for the outreach send path. No dependency — the HTML comes
 * from our own draft editor (a small, trusted control), so this is a defensive
 * whitelist, not a full sanitizer. It strips anything that isn't one of a few
 * email-safe inline/block tags and removes every attribute except safe `href`s.
 */

// Tags the draft editor can produce (execCommand: bold/italic/link/bullet) plus
// the structural wrappers browsers wrap lines in. Everything else is unwrapped.
const ALLOWED_TAGS = new Set(['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li']);

/**
 * Whitelist-sanitize editor HTML for sending. Drops disallowed tags (keeping
 * their text), strips all attributes except `href` on <a> (http/https/mailto
 * only), and removes <script>/<style> blocks wholesale.
 */
export function sanitizeEmailHtml(html: string): string {
  // Remove script/style blocks including their content.
  let out = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  out = out.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (_m, tagRaw: string, attrs: string) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ''; // drop the tag, keep inner text
    const closing = /^<\//.test(_m);
    if (closing) return `</${tag}>`;
    if (tag === 'a') {
      const href = (attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])
        .slice(2).find(Boolean) || '';
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        const safe = href.replace(/"/g, '&quot;');
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    return `<${tag}>`; // strip all other attributes
  });

  return out.trim();
}

/**
 * Plain-text fallback for the email's `text` part (deliverability + clients that
 * prefer text). Converts block boundaries to newlines and strips remaining tags.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|ul|ol|h\d)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
