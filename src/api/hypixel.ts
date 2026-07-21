/**
 * Direct browser → Hypixel calls, used by the Tracked scan page.
 *
 * Hypixel serves CORS headers, so these work from the page. Everything left
 * here is KEYLESS — the one keyed call, testApiKey, exists purely to check a
 * key before handing it to the server, which is where keys now live.
 *
 * The API has a cached server-side sweep at /api/sweep that does the same job
 * as sweepAuctions without making each visitor pull ~50MB. Prefer it.
 */

const BASE = 'https://api.hypixel.net/v2';

export interface BazaarProduct {
  product_id: string;
  quick_status: {
    productId: string;
    sellPrice: number;
    sellVolume: number;
    sellMovingWeek: number;
    sellOrders: number;
    buyPrice: number;
    buyVolume: number;
    buyMovingWeek: number;
    buyOrders: number;
  };
}

export interface BazaarResponse {
  success: boolean;
  lastUpdated: number;
  products: Record<string, BazaarProduct>;
}

async function call<T>(path: string, key?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: key ? { 'API-Key': key } : undefined,
  });

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

  return (await res.json()) as T;
}

/** No key required. */
export function getBazaar(): Promise<BazaarResponse> {
  return call<BazaarResponse>('/skyblock/bazaar');
}

/** No key required. One page of currently active auctions. */
export function getActiveAuctions(page = 0) {
  return call<{
    success: boolean;
    page: number;
    totalPages: number;
    totalAuctions: number;
    lastUpdated: number;
    auctions: {
      uuid: string;
      auctioneer: string;
      item_name: string;
      tier: string;
      starting_bid: number;
      highest_bid_amount: number;
      bin: boolean;
      end: number;
      item_bytes: string;
    }[];
  }>(`/skyblock/auctions?page=${page}`);
}

/**
 * No key required. Canonical metadata for every item: name, tier, category,
 * stats, gemstone slots, and — usefully — `upgrade_costs`, the exact essence
 * cost of each dungeon star tier.
 */
export function getItemMetadata() {
  return call<{ success: boolean; items: ItemMetaRaw[] }>('/resources/skyblock/items');
}

export interface ItemMetaRaw {
  id: string;
  name?: string;
  tier?: string;
  category?: string;
  material?: string;
  npc_sell_price?: number;
  stats?: Record<string, number>;
  upgrade_costs?: { type: string; essence_type?: string; item_id?: string; amount: number }[][];
  gemstone_slots?: { slot_type: string; costs?: unknown[] }[];
}

/**
 * Requires a key. /v2/counts takes no parameters, which makes it the cheapest
 * way to prove a key is valid.
 */
export async function testApiKey(key: string): Promise<{ playerCount: number }> {
  const data = await call<{ success: boolean; playerCount: number }>('/counts', key);
  return { playerCount: data.playerCount };
}

/** Mojang username → UUID. Separate service, no Hypixel key involved. */
export async function resolveUuid(username: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
  if (res.status === 404) throw new Error(`No Minecraft account named "${username}".`);
  if (!res.ok) throw new Error(`Mojang lookup failed (${res.status}).`);
  return (await res.json()) as { id: string; name: string };
}

export interface ActiveListing {
  uuid: string;
  auctioneer: string;
  item_name: string;
  tier: string;
  starting_bid: number;
  highest_bid_amount: number;
  bin: boolean;
  end: number;
  item_bytes: string;
}

/**
 * Pages through every active auction looking for listings by the given sellers.
 *
 * There is no server-side filter for this — the only way to find a player's
 * listings without an API key is to read the whole book. That is ~52 pages and
 * ~50MB, so this is button-triggered, never automatic.
 */
export async function sweepAuctions(
  opts: {
    /** Collect listings by these sellers. */
    sellers?: Set<string>;
    /** Collect BIN listings whose display name contains any of these. */
    names?: string[];
    /** Never collect name-matches from these sellers (avoids self-reference). */
    excludeSellers?: Set<string>;
  },
  onProgress?: (done: number, total: number) => void,
  concurrency = 6,
): Promise<{
  sellerHits: ActiveListing[];
  nameHits: ActiveListing[];
  scanned: number;
  totalPages: number;
}> {
  const first = await getActiveAuctions(0);
  const totalPages = first.totalPages;
  const needles = (opts.names ?? []).map((n) => n.toLowerCase());

  const sellerHits: ActiveListing[] = [];
  const nameHits: ActiveListing[] = [];
  let scanned = 0;
  let done = 0;

  const collect = (auctions: ActiveListing[]) => {
    scanned += auctions.length;
    for (const a of auctions) {
      if (opts.sellers?.has(a.auctioneer)) sellerHits.push(a);
      if (a.bin && needles.length > 0 && !opts.excludeSellers?.has(a.auctioneer)) {
        const name = a.item_name.toLowerCase();
        if (needles.some((n) => name.includes(n))) nameHits.push(a);
      }
    }
    done++;
    onProgress?.(done, totalPages);
  };

  collect(first.auctions as ActiveListing[]);

  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((p) => getActiveAuctions(p).catch(() => null)),
    );
    for (const r of results) {
      if (r) collect(r.auctions as ActiveListing[]);
      else done++;
    }
  }

  return { sellerHits, nameHits, scanned, totalPages };
}

