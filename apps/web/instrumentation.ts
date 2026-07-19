/**
 * Node runtime boot hook. Keeps HTTPS connections to Supabase alive between
 * requests: undici's default idle timeout is 4s, so nearly every page
 * navigation was paying a fresh TCP+TLS handshake (~300-400ms measured) on
 * its first query. A long keep-alive turns that into a reused connection.
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
  }
}
