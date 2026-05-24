/**
 * Quick bench: fetch a real HTML page, run compress(), print before/after.
 *
 *   pnpm --filter @agent-crm/tools exec tsx scripts/compress_bench.ts <url>
 *
 * Defaults to a Y Combinator company page if no URL is supplied — that's
 * representative of pages we hit through the web/exa connectors.
 */
import { compress, estimateTokens } from '../src/compress.ts';

const URL = process.argv[2] ?? 'https://www.ycombinator.com/companies/openai';

async function main() {
  const res = await fetch(URL, { headers: { 'user-agent': 'agent-crm-bench/1.0' } });
  const html = await res.text();
  const inputTokens = estimateTokens(html);
  const compressed = await compress(html, { max_chars: 0 });

  const ratio = compressed.token_estimate / Math.max(1, inputTokens);
  const pct = ((1 - ratio) * 100).toFixed(1);

  console.log(`URL:              ${URL}`);
  console.log(`HTTP status:      ${res.status}`);
  console.log(`Input chars:      ${compressed.stats.input_chars.toLocaleString()}`);
  console.log(`  est tokens:     ${inputTokens.toLocaleString()}`);
  console.log(`After markdown:   ${compressed.stats.after_markdown_chars.toLocaleString()} chars`);
  console.log(`After URL refs:   ${compressed.stats.after_urls_chars.toLocaleString()} chars`);
  console.log(`Final output:     ${compressed.stats.output_chars.toLocaleString()} chars`);
  console.log(`  est tokens:     ${compressed.token_estimate.toLocaleString()}`);
  console.log(`URL refs found:   ${compressed.refs.length}`);
  console.log(`Token reduction:  ${pct}%`);
  console.log(`\nFirst 600 chars of output:\n${compressed.text.slice(0, 600)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
