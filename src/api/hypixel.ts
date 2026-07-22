/**
 * The last direct browser → Hypixel call.
 *
 * Everything else moved server-side: the API holds the key, sweeps the auction
 * house, decodes NBT and prices recipes. What remains is a pre-flight check so
 * /settings can tell you a key is dead before sending it anywhere — the server
 * verifies again before storing, so this is a courtesy, not the gate.
 */

const BASE = 'https://api.hypixel.net/v2';

/**
 * Requires a key. /v2/counts takes no parameters, which makes it the cheapest
 * way to prove a key is valid.
 */
export async function testApiKey(key: string): Promise<{ playerCount: number }> {
  const res = await fetch(`${BASE}/counts`, { headers: { 'API-Key': key } });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { cause?: string };
      if (body.cause) detail = body.cause;
    } catch {
      /* keep statusText */
    }
    const hint =
      res.status === 403
        ? 'Invalid or missing API key.'
        : res.status === 429
          ? 'Rate limit reached — the key allows 120 requests per minute.'
          : detail;
    throw new Error(`${res.status}: ${hint}`);
  }

  const data = (await res.json()) as { playerCount: number };
  return { playerCount: data.playerCount };
}
