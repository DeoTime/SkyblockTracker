import { reforgeKey } from './items.js';

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

/**
 * Items priced from a rolling AVERAGE of what sold, not the cheapest listing.
 *
 * The Etherwarp Merger is the whole reason this exists. It is one of the two
 * big lines on an etherwarped Aspect of the Void and it trades only a handful
 * of times an hour, so `min_price` of the nearest bucket is whatever one lucky
 * listing went for — a number that jumps hundreds of thousands of coins between
 * adjacent days without the market having moved, and jumps in the direction
 * that understates cost and overstates margin. Averaging every sale over a
 * rolling day is both steadier and closer to what a buyer actually pays.
 *
 * Deliberately NOT the Etherwarp Conduit, despite the same thin market: it has
 * a recipe, so costOf() prices it from ingredients and never reaches this path.
 * Adding it here would change nothing and imply otherwise.
 */
const ROLLING_MEAN = new Set(['ETHERWARP_MERGER']);

/** Length of that rolling window. */
const ROLLING_HOURS = 24;

/**
 * Widened window for ownBuyMean() when the ordinary one is empty.
 *
 * A component bought a few times a week has no purchase in most single days,
 * and a cost line that is null four days in five is not a line. Two days is the
 * smallest widening that meaningfully helps while still being recent enough to
 * describe the day it is charted against; the days that use it are marked
 * `live_fallback` so they read as estimated rather than measured.
 */
const ROLLING_FALLBACK_HOURS = 48;

const HOUR = 3600_000;
const hourOf = (ms) => Math.floor(ms / HOUR);

export class PriceBook {
  /**
   * @param db      better-sqlite3 handle
   * @param at      epoch ms the prices should be "as of"
   * @param opts.live  optional { bazaar: Map<id,number>, auction: Map<id,number> }
   *                   used only when history has no answer at all
   * @param opts.ownBuys  item ids to price ONLY from what a tracked player
   *                   actually paid — see ownBuyMean(). Opt-in per book,
   *                   because it answers a different question than the market
   *                   price and is null far more often.
   */
  constructor(db, at, opts = {}) {
    this.at = at;
    this.live = opts.live ?? null;
    this.ownBuys = new Set(opts.ownBuys ?? []);
    this.db = db;
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
    this.qRollupMean = db.prepare(
      `SELECT SUM(sum_price) AS sum, SUM(sales) AS sales FROM price_rollup
        WHERE item_id = ? AND is_clean = ? AND hour BETWEEN ? AND ?`,
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
   * Mean of what a TRACKED player actually PAID for `itemId` over the
   * ROLLING_HOURS ending at `at` — not what the market charged anyone.
   *
   * `tracked_buys` is entirely our own players' purchases by construction: the
   * live feed only writes a row when the buyer is tracked, and the Coflnet
   * backfill only ever walks a tracked player's own bids. So the table needs no
   * buyer predicate — every row in it already qualifies. Not narrowed to one
   * player: the chart is not per-player, and splitting it would halve an
   * already thin sample.
   *
   * A day with no purchase widens to ROLLING_FALLBACK_HOURS before giving up.
   * The wider window is a superset, so it is only ever consulted when the
   * ordinary one found nothing, and it is marked `live_fallback` — the number
   * is real but it describes two days rather than the one it is charted on.
   *
   * STRICT past that. Null means "no tracked player bought one in either
   * window", and the caller must treat it as no price rather than reaching for
   * the market — falling back there would quietly restore the all-sales number
   * this exists to replace, on exactly the days it was asked not to.
   */
  ownBuyMean(itemId) {
    try {
      // Prepared lazily: the API and the ingest deploy separately, so an API
      // running ahead of the ingest meets a database with no tracked_buys at
      // all, and a missing table throws at prepare time, not at call time.
      this.qOwnBuyMean ??= this.db.prepare(
        `SELECT AVG(price) AS mean, COUNT(*) AS n FROM tracked_buys
          WHERE item_id = ? AND bought_at BETWEEN ? AND ?`,
      );

      for (const [hours, source] of [
        [ROLLING_HOURS, 'own_snapshot'],
        [ROLLING_FALLBACK_HOURS, 'live_fallback'],
      ]) {
        const row = this.qOwnBuyMean.get(itemId, this.at - hours * HOUR, this.at);
        if (row?.n) {
          this.note(itemId, source);
          return Math.round(row.mean);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Mean sale price over the ROLLING_HOURS ending at `at`, or null if nothing
   * sold in that window.
   *
   * Weighted by sales rather than by hour — an hour that saw six sales should
   * count six times as much as one that saw a single sale, and summing the
   * hourly means instead would let the quietest hour of the day set the price.
   * `sum_price / sales` over the range is exactly the mean of the individual
   * sales in it.
   *
   * Trailing, not centred: the newest point's anchor is "now", so a centred
   * window there would be half empty and would draw on a different span than
   * every other point on the same line.
   */
  rollingMean(itemId, flag) {
    const h = hourOf(this.at);
    const row = this.qRollupMean.get(itemId, flag, h - (ROLLING_HOURS - 1), h);
    // SUM over no rows is a row of nulls, not an absent row.
    if (!row?.sales) return null;
    return Math.round(row.sum / row.sales);
  }

  /**
   * Cheapest CLEAN auction sale near `at`, from the hourly rollup.
   * `clean = false` prices upgraded variants (used for auction-only upgrades
   * like the Etherwarp Conduit, which are never "clean" in the base sense).
   *
   * Two exceptions to "cheapest", in priority order:
   *
   *   opts.ownBuys   priced from our own purchases alone, and NOT backstopped —
   *                  see ownBuyMean(). Returns before everything below it.
   *   ROLLING_MEAN   averaged over a rolling day of everyone's sales, but still
   *                  backstopped, so an empty window falls through to the
   *                  ordinary nearest-bucket answer rather than to no price.
   *
   * Everything else about the lookup — the freshness downgrade, the clean/dirty
   * fallback — is unchanged.
   */
  auction(itemId, { clean = true, windowHours = 72 } = {}) {
    const h = hourOf(this.at);
    const flag = clean ? 1 : 0;

    // Deliberately unconditional: null here is an answer, not a miss.
    // tracked_buys has no clean/dirty split, so the flag does not apply.
    if (this.ownBuys.has(itemId)) return this.ownBuyMean(itemId);

    if (ROLLING_MEAN.has(itemId)) {
      const mean = this.rollingMean(itemId, flag);
      if (mean !== null) {
        // Not downgraded for age: spanning a day is the point of this number,
        // not evidence that the reading is stale.
        this.note(itemId, 'own_snapshot');
        return mean;
      }
    }

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

const NEU = 'https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master';
const REPO = `${NEU}/items`;

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

/** Grid slot keys are A1..C3; everything else on the object is metadata. */
const RECIPE_META = new Set(['count', 'type', 'overrideOutputId', 'duration']);

function parseOne(grid) {
  if (!grid || typeof grid !== 'object') return null;

  const ingredients = new Map();
  const add = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    // "ENCHANTED_DIAMOND:32", and ids may carry a ";variant" suffix.
    // Forge quantities come through as floats ("REFINED_MINERAL:32.0").
    const [idPart, qtyPart] = raw.split(':');
    const id = idPart.split(';')[0];
    if (!id) return;
    // One ingredient can occupy several grid slots; each contributes.
    ingredients.set(id, (ingredients.get(id) ?? 0) + (Number(qtyPart) || 1));
  };

  if (Array.isArray(grid.inputs)) {
    // Forge recipe: a flat inputs array rather than a 3x3 grid. Divan's armour,
    // Gemstone Mixture and Powder Coating are all forge-only, and treating them
    // as recipe-less made the tracker price their base at market — which, for a
    // flip held under an hour, is the seller's own sale price.
    for (const raw of grid.inputs) add(raw);
  } else {
    for (const [slot, raw] of Object.entries(grid)) {
      if (RECIPE_META.has(slot)) continue;
      add(raw);
    }
  }

  if (ingredients.size === 0) return null;
  return { ingredients, outputCount: Number(grid.count ?? 1) || 1 };
}

/**
 * NEU stores either a single `recipe` (crafting grid) or a `recipes` array,
 * which may hold forge entries. Take the first that yields ingredients.
 */
export function parseRecipe(item) {
  const candidates = [];
  if (item?.recipe) candidates.push(item.recipe);
  if (Array.isArray(item?.recipes)) candidates.push(...item.recipes);

  for (const c of candidates) {
    const parsed = parseOne(c);
    if (parsed) return parsed;
  }
  return null;
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
/* Reforges                                                            */
/* ------------------------------------------------------------------ */

let reforgeCache = null;
let reforgeFetchedAt = 0;

/**
 * The two reforge tables, keyed by normalised modifier:
 *
 *   basic   Reforge Anvil rerolls. A coin fee, no item — cost basis zero.
 *   stones  reforge-stone reforges → the stone's item id. The stone is consumed.
 *
 * NEU keeps them in separate files and they do not overlap, which is the only
 * thing that separates a free reroll from a Dragon Claw. So a modifier in
 * NEITHER table stays unpriced rather than being assumed free, and a failed
 * fetch returns null (or the stale table) — never an empty set, which would
 * quietly zero every reforge on the server.
 */
export async function reforgeTables() {
  if (reforgeCache && Date.now() - reforgeFetchedAt < META_TTL) return reforgeCache;

  try {
    const [anvil, stones] = await Promise.all(
      ['reforges', 'reforgestones'].map(async (file) => {
        const r = await fetch(`${NEU}/constants/${file}.json`);
        if (!r.ok) throw new Error(`${file}.json: ${r.status}`);
        return r.json();
      }),
    );

    const basic = new Set();
    for (const v of Object.values(anvil)) if (v?.reforgeName) basic.add(reforgeKey(v.reforgeName));

    const byStone = new Map();
    for (const [key, v] of Object.entries(stones)) {
      if (v?.reforgeName) byStone.set(reforgeKey(v.reforgeName), v.internalName ?? key);
    }

    if (basic.size === 0 || byStone.size === 0) throw new Error('empty reforge table');
    reforgeCache = { basic, stones: byStone };
    reforgeFetchedAt = Date.now();
  } catch {
    // Keep whatever we had; if we never had one, callers get null and price
    // nothing.
  }
  return reforgeCache;
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
