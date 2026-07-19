/**
 * Node runtime boot hook. Two jobs, one goal: no request should pay a fresh
 * TCP+TLS handshake to Supabase (~300-400ms measured).
 *
 * 1. Keep-alive: undici's default idle timeout is 4s, so nearly every page
 *    navigation was paying a handshake on its first query.
 * 2. Warm ping: even with keep-alive, a 60s+ idle gap (user comes back after
 *    a minute — measured 1.35s on the feed) empties the pool. A tiny ping
 *    every 45s holds 3 pooled connections open, and any server-side close is
 *    absorbed by the ping instead of the next real request. The response is a
 *    401 (no api key) — irrelevant, the completed exchange is what keeps the
 *    connection alive. ~2K pings/day at a few hundred bytes each.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setGlobalDispatcher, Agent } = await import('undici');
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 10 * 60_000,
      }),
    );

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const ping = () => {
        for (let i = 0; i < 3; i++) {
          fetch(`${supabaseUrl}/rest/v1/`, { method: 'HEAD' }).catch(() => {});
        }
      };
      ping();
      setInterval(ping, 45_000).unref();
    }
  }
}
