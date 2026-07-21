/**
 * Historical pricing.
 *
 * Everything here answers one question: "what did this cost at time T?" — not
 * "what does it cost now". Using today's price for a flip crafted three weeks
 * ago is the single easiest way to produce confident, wrong profit numbers.
 *
 * Two stores back it, and they are not interchangeable:
 *   bazaar_snapshot  exact (item, ts) points, written on material moves
 *   price_rollup     hourly min/max/count per (item, hour, is_clean)
 *
 * Rollup reads MUST filter is_clean = 1 for base items. An hour bucket that
 * mixes a bare Aspect of the Void with a fully-gemmed one has a min that is
 * meaningless as a base price.
 */

/** Rollup/snapshot older than this is stale enough to downgrade confidence. */
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Items that only ever exist upgraded — see the fallback in auction(). */
const AUCTION_ONLY = new Set(['ETHERWARP_CONDUIT', 'ETHERWARP_MERGER']);

const HOUR = 3600_000;
const hourOf = (ms) => Math.floor(ms / HOUR);

export class PriceBook {
  /**
   * @param db      better-sqlite3 handle
   * @param at      epoch ms the prices should be "as of"
   * @param opts.live  optional { bazaar: Map<id,number>, auction: Map<id,number> }
   *                   used only when history has no answer at all
   */
  constructor(db, at, opts = {}) {
    this.at = at;
    this.live = opts.live ?? null;
    this.sources = new Map();

    this.qBazaarBefore = db.prepare(
      `SELECT buy_price, sell_price, ts FROM bazaar_snapshot
        WHERE item_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
    );
    this.qBazaarAny = db.prepare(
      `SELECT buy_price, sell_price, ts FROM bazaar_snapshot
        WHERE item_id = ? ORDER BY ABS(ts - ?) ASC LIMIT 1`,
    );
    this.qRollup = db.prepare(
      `SELECT min_price, sum_price, sales, hour FROM price_rollup
        WHERE item_id = ? AND is_clean = ? AND hour BETWEEN ? AND ?
        ORDER BY ABS(hour - ?) ASC LIMIT 1`,
    );
    this.qRollupAny = db.prepare(
      `SELECT min_price, sum_price, sales, hour FROM price_rollup
        WHERE item_id = ? AND is_clean = ? ORDER BY ABS(hour - ?) ASC LIMIT 1`,
    );

    this.bazaar = this.bazaar.bind(this);
    this.auction = this.auction.bind(this);
  }

  note(itemId, source) {
    this.sources.set(itemId, source);
    return source;
  }

  /**
   * Bazaar instant-buy at `at`, or null if the item does not trade there.
   *
   * buy_price 0 with a non-zero sell_price is a real state (nobody is selling
   * into buy orders) — falling back to sell_price is closer to what an actual
   * purchase costs than reporting "free".
   */
  bazaar(itemId) {
    let row = this.qBazaarBefore.get(itemId, this.at);
    let source = 'own_snapshot';

    if (!row) {
      // Item existed before our history starts. Nearest point is the honest
      // best effort, but it is not a snapshot of the moment.
      row = this.qBazaarAny.get(itemId, this.at);
      source = 'live_fallback';
    } else if (this.at - row.ts > FRESH_WINDOW_MS) {
      source = 'live_fallback';
    }

    if (!row) {
      const live = this.live?.bazaar?.get(itemId);
      if (live === undefined) return null;
      this.note(itemId, 'live_fallback');
      return live;
    }

    const price = row.buy_price > 0 ? row.buy_price : row.sell_price;
    this.note(itemId, source);
    return price; // may legitimately be 0 — both sides empty
  }

  /**
   * Cheapest CLEAN auction sale near `at`, from the hourly rollup.
   * `clean = false` prices upgraded variants (used for auction-only upgrades
   * like the Etherwarp Conduit, which are never "clean" in the base sense).
   */
  auction(itemId, { clean = true, windowHours = 72 } = {}) {
    const h = hourOf(this.at);
    const flag = clean ? 1 : 0;

    let row = this.qRollup.get(itemId, flag, h - windowHours, h + windowHours, h);
    let source = 'own_snapshot';

    if (!row) {
      row = this.qRollupAny.get(itemId, flag, h);
      source = 'live_fallback';
    }

    // Etherwarp Conduits and Mergers are never listed clean, so for those the
    // dirty bucket is the only price there is — better than reporting the most
    // expensive upgrade on the item as free. Deliberately NOT general: for a
    // base item, falling back to dirty listings prices someone else's gemstones
    // into your cost basis.
    if (!row && clean && AUCTION_ONLY.has(itemId)) {
      return this.auction(itemId, { clean: false, windowHours });
    }

    if (!row) {
      const live = this.live?.auction?.get(itemId);
      if (live === undefined) return null;
      this.note(itemId, 'live_fallback');
      return live;
    }

    this.note(itemId, source);
    return row.min_price;
  }

  /** Worst (least trustworthy) source touched so far. */
  worstSource() {
    for (const s of this.sources.values()) if (s === 'live_fallback') return 'live_fallback';
    return this.sources.size ? 'own_snapshot' : 'live_fallback';
  }
}

/* ------------------------------------------------------------------ */
/* NEU recipes                                                         */
/* ------------------------------------------------------------------ */

const REPO =
  'https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items';

const neuCache = new Map();
const neuInflight = new Map();

export async function fetchNeuItem(itemId) {
  if (neuCache.has(itemId)) return neuCache.get(itemId);
  const pending = neuInflight.get(itemId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const r = await fetch(`${REPO}/${encodeURIComponent(itemId)}.json`);
      const v = r.ok ? await r.json() : null;
      neuCache.set(itemId, v);
      return v;
    } catch {
      neuCache.set(itemId, null); // network blip caches as "no recipe" for this run only
      return null;
    } finally {
      neuInflight.delete(itemId);
    }
  })();

  neuInflight.set(itemId, p);
  return p;
}

export function parseRecipe(item) {
  const grid = item?.recipe ?? item?.recipes?.[0];
  if (!grid) return null;

  const ingredients = new Map();
  for (const [slot, raw] of Object.entries(grid)) {
    if (slot === 'count' || slot === 'type' || slot === 'overrideOutputId') continue;
    if (typeof raw !== 'string' || raw.length === 0) continue;

    // "ENCHANTED_DIAMOND:32", and ids may carry a ";variant" suffix.
    const [idPart, qtyPart] = raw.split(':');
    const id = idPart.split(';')[0];
    if (!id) continue;
    // One ingredient can occupy several grid slots; each contributes.
    ingredients.set(id, (ingredients.get(id) ?? 0) + (Number(qtyPart) || 1));
  }

  if (ingredients.size === 0) return null;
  return { ingredients, outputCount: Number(grid.count ?? 1) || 1 };
}

/**
 * Cost one unit, preferring what it costs to CRAFT.
 *
 * Craft → bazaar → clean auction. Craft wins because that is what the tracked
 * seller actually did; pricing their base at someone else's asking price
 * overstates cost and has already flipped a real +2.35M flip to a -401k loss
 * once in this project.
 *
 * A commodity that trades on the bazaar stops the recursion — otherwise every
 * recipe expands down to cobblestone.
 */
export async function costOf(itemId, book, depth = 0, seen = new Set()) {
  const empty = { itemId, price: null, source: null, craftCost: null, marketPrice: null, parts: [] };

  const bz = book.bazaar(itemId);
  // Clean listings only. A rollup bucket that includes gemmed, starred copies
  // has a min that is not the price of the bare item.
  const ah = book.auction(itemId, { clean: true });
  const market = bz ?? ah;
  const marketSource = bz !== null ? 'bazaar' : ah !== null ? 'auction' : null;

  if (depth > 4 || seen.has(itemId)) {
    return { ...empty, price: market, source: marketSource, marketPrice: market };
  }
  if (depth > 0 && bz !== null) {
    return { ...empty, price: bz, source: 'bazaar', marketPrice: bz };
  }

  const recipe = parseRecipe(await fetchNeuItem(itemId));
  if (!recipe) return { ...empty, price: market, source: marketSource, marketPrice: market };

  const nextSeen = new Set(seen).add(itemId);
  const parts = [];
  let sum = 0;
  let complete = true;

  for (const [ing, qty] of recipe.ingredients) {
    const sub = await costOf(ing, book, depth + 1, nextSeen);
    parts.push({ itemId: ing, quantity: qty, unitPrice: sub.price });
    if (sub.price === null) complete = false;
    else sum += sub.price * qty;
  }

  const craftCost = complete ? sum / recipe.outputCount : null;
  return {
    itemId,
    price: craftCost ?? market,
    source: craftCost !== null ? 'craft' : marketSource,
    craftCost,
    marketPrice: market,
    parts,
  };
}

/* ------------------------------------------------------------------ */
/* Item metadata                                                       */
/* ------------------------------------------------------------------ */

let metaCache = null;
let metaFetchedAt = 0;
const META_TTL = 24 * 3600_000;

/** Official item metadata: display names, tiers, star upgrade_costs. */
export async function itemMetadata() {
  if (metaCache && Date.now() - metaFetchedAt < META_TTL) return metaCache;
  try {
    const r = await fetch('https://api.hypixel.net/v2/resources/skyblock/items');
    const j = await r.json();
    const map = new Map();
    for (const it of j.items ?? []) map.set(it.id, it);
    metaCache = map;
    metaFetchedAt = Date.now();
  } catch {
    metaCache = metaCache ?? new Map(); // serve stale rather than fail the request
  }
  return metaCache;
}
