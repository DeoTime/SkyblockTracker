/**
 * Server-side auction-house sweep.
 *
 * There is no server-side filter for "listings by player X", so finding them
 * means reading the whole book: ~52 pages, ~50MB. Doing that in the browser
 * makes every visitor pull 50MB and burns their connection; doing it here means
 * one fetch shared by everyone, cached.
 *
 * The endpoint itself is keyless — /skyblock/auctions needs no API key. The
 * stored key is used for the player-auctions call further down, which does.
 */

const BASE = 'https://api.hypixel.net/v2';

/**
 * The auction book only changes as fast as Hypixel regenerates it, and a sweep
 * is 52 requests. Serving a slightly stale book beats re-reading it per click.
 */
const TTL_MS = 60_000;
const CONCURRENCY = 6;

let cache = null; // { at, pages: [[listing, …], …], totalPages, scanned }
let inflight = null;

async function page(n) {
  const res = await fetch(`${BASE}/skyblock/auctions?page=${n}`);
  if (!res.ok) throw new Error(`Hypixel returned ${res.status} on auctions page ${n}.`);
  return res.json();
}

async function readBook() {
  const first = await page(0);
  const totalPages = first.totalPages ?? 1;
  const pages = [first.auctions ?? []];

  const rest = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = rest.slice(i, i + CONCURRENCY);
    // A failed page is skipped rather than failing the sweep: one 502 out of 52
    // should degrade the result, not destroy it.
    const results = await Promise.all(batch.map((p) => page(p).catch(() => null)));
    for (const r of results) if (r) pages.push(r.auctions ?? []);
  }

  return { at: Date.now(), pages, totalPages, scanned: pages.reduce((a, p) => a + p.length, 0) };
}

/** The whole active book, cached. Concurrent callers share one read. */
export async function auctionBook() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = readBook()
    .then((b) => {
      cache = b;
      return b;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * @param sellers        collect listings by these auctioneer uuids
 * @param names          collect BIN listings whose name contains any of these
 * @param excludeSellers never name-match these sellers (avoids self-reference:
 *                       pricing a tracked player's item off their own listing)
 */
export async function sweep({ sellers = [], names = [], excludeSellers = [] } = {}) {
  const book = await auctionBook();

  const sellerSet = new Set(sellers);
  const excludeSet = new Set(excludeSellers);
  const needles = names.map((n) => n.toLowerCase()).filter(Boolean);

  const sellerHits = [];
  const nameHits = [];

  for (const pageAuctions of book.pages) {
    for (const a of pageAuctions) {
      if (sellerSet.has(a.auctioneer)) sellerHits.push(a);
      if (a.bin && needles.length > 0 && !excludeSet.has(a.auctioneer)) {
        const name = (a.item_name ?? '').toLowerCase();
        if (needles.some((n) => name.includes(n))) nameHits.push(a);
      }
    }
  }

  return {
    sellerHits,
    nameHits,
    scanned: book.scanned,
    totalPages: book.totalPages,
    cachedAt: new Date(book.at).toISOString(),
    ageSeconds: Math.round((Date.now() - book.at) / 1000),
  };
}

/**
 * A player's own auctions. This one genuinely needs the stored key — and note
 * it returns only UNCLAIMED auctions, so it is a view of what is currently in
 * flight, not a sales history.
 */
export async function playerAuctions(playerUuid, key) {
  const res = await fetch(`${BASE}/skyblock/auction?player=${encodeURIComponent(playerUuid)}`, {
    headers: { 'API-Key': key },
  });
  if (res.status === 403) throw new Error('The stored Hypixel key was rejected. Set a new one on /settings.');
  if (!res.ok) throw new Error(`Hypixel returned ${res.status}.`);
  const body = await res.json();
  return body.auctions ?? [];
}
