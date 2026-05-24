export function lowConfLabel(c: number | null | undefined): string | null {
  if (c == null || typeof c !== 'number' || !isFinite(c)) return null;
  return c < 0.7 ? `⚠ low conf ${c.toFixed(2)}` : null;
}
