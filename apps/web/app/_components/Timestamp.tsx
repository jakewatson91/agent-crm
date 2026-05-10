'use client';

/**
 * Renders a timestamp using the browser's locale + timezone, but tells React not to
 * warn about server/client hydration mismatch. The server renders in UTC, the client
 * in user-local time — that's expected and intentional, not a real bug.
 */
export function Timestamp({ value, fallback = '—' }: { value: string | null | undefined; fallback?: string }) {
  if (!value) return <span>{fallback}</span>;
  return <span suppressHydrationWarning>{new Date(value).toLocaleString()}</span>;
}
