/**
 * "What does it cost to make one, right now?"
 *
 * The rest of this API answers the historical question — what did an ingredient
 * cost at the moment a flip was crafted (see PriceBook in prices.js). This
 * module answers the present-tense one, so it deliberately does NOT touch the
 * database: it prices against the live bazaar and the live auction book.
 *
 * The recursion itself is `costOf()` from prices.js, unchanged. costOf only
 * ever calls two methods on the book it is handed — bazaar() and auction() — so
 * a live-priced book slots straight in, and the craft/bazaar/auction preference
 * order stays identical to the one the flip pages use. Reimplementing that
 * ordering here is how the two views start disagreeing about the same item.
 */

import { auctionBook } from './sweep.js';
import { costOf, itemMetadata, fetchNeuItem, parseRecipe } from './prices.js';
import { readExtraAttributes, isCleanBase } from './items.js';

const BASE = 'https://api.hypixel.net/v2';

/* ------------------------------------------------------------------ */
/* Live bazaar                                                         */
/* ------------------------------------------------------------------ */

/**
 * The bazaar endpoint is one keyless request for all ~1,900 products, and
 * Hypixel only regenerates it every 20s or so. Cache it for a minute rather
 * than re-pulling per ingredient.
 */
const BAZAAR_TTL_MS = 60_000;

/**
 * How deep to keep the per-item order book. Enough for the floor plus the ten
 * behind it, which is what the UI shows; the rest is trimmed so a 190-listing
 * item does not ship its whole book to the browser.
 */
const LISTING_DEPTH = 12;

let bzCache = null; // { at, prices: Map<id, {buy, sell}> }
let bzInflight = null;

async function readBazaar() {
  const res = await fetch(`${BASE}/skyblock/bazaar`);
  if (!res.ok) throw new Error(`Hypixel returned ${res.status} on the bazaar.`);
  const body = await res.json();

  const prices = new Map();
  for (const [id, product] of Object.entries(body.products ?? {})) {
    const q = product.quick_status ?? {};
    prices.set(id, { buy: Number(q.buyPrice ?? 0), sell: Number(q.sellPrice ?? 0) });
  }
  return { at: Date.now(), prices };
}

export async function liveBazaar() {
  if (bzCache && Date.now() - bzCache.at < BAZAAR_TTL_MS) return bzCache;
  if (bzInflight) return bzInflight;

  bzInflight = readBazaar()
    .then((b) => {
      bzCache = b;
      return b;
    })
    .finally(() => {
      bzInflight = null;
    });

  return bzInflight;
}

/* ------------------------------------------------------------------ */
/* Live lowest-BIN                                                     */
/* ------------------------------------------------------------------ */

/**
 * Lowest live BIN for a handful of named items.
 *
 * The book is ~52 pages and ~50k listings; gunzip-and-parse on every one of
 * them to read an item id would take minutes. So filter by display name first
 * and decode only the survivors — the same two-step snipe.js uses. The name is
 * a *filter*, never the answer: reforges prefix the display name and the id
 * only exists in the NBT, so every candidate is confirmed by its decoded id.
 *
 * `etherwarp` is tracked alongside `clean` because the two are the only
 * like-for-like references the etherwarp variant has: an Aspect of the Void
 * with the Conduit merged in carries `ethermerge` in its NBT, and comparing a
 * 21M etherwarp build against the cheapest bare sword on the book is a
 * comparison between two different items.
 *
 * @param needles  lowercased display-name substrings to look for
 * @returns Map<itemId, { clean, any, etherwarp, cleanCount, etherwarpCount, count, listings }>
 */
async function lowestBins(needles) {
  const book = await auctionBook();
  if (needles.length === 0) return { book, bins: new Map() };

  const candidates = [];
  for (const page of book.pages) {
    for (const a of page) {
      if (!a.bin) continue;
      const name = (a.item_name ?? '').toLowerCase();
      if (needles.some((n) => name.includes(n))) candidates.push(a);
    }
  }

  const bins = new Map();
  for (const a of candidates) {
    let ea = null;
    try {
      ea = await readExtraAttributes(a.item_bytes);
    } catch {
      continue; // corrupt NBT — one bad listing must not sink the scan
    }
    const id = typeof ea?.id === 'string' ? ea.id : null;
    if (!id) continue;

    const price = Number(a.starting_bid ?? 0);
    if (!(price > 0)) continue;

    const e =
      bins.get(id) ??
      { clean: null, any: null, etherwarp: null, cleanCount: 0, etherwarpCount: 0, count: 0, listings: [] };
    e.count += 1;
    e.any = e.any === null ? price : Math.min(e.any, price);
    if (isCleanBase(ea)) {
      e.cleanCount += 1;
      e.clean = e.clean === null ? price : Math.min(e.clean, price);
    }
    if ('ethermerge' in ea) {
      e.etherwarpCount += 1;
      e.etherwarp = e.etherwarp === null ? price : Math.min(e.etherwarp, price);
    }
    // The whole order book for this item, not just its floor: one listing is a
    // price, several are a market. Trimmed to LISTING_DEPTH below.
    e.listings.push({
      auctionId: a.uuid,
      price,
      endsAt: Number.isFinite(Number(a.end)) ? new Date(Number(a.end)).toISOString() : null,
      clean: isCleanBase(ea),
    });
    bins.set(id, e);
  }

  for (const e of bins.values()) {
    e.listings.sort((x, y) => x.price - y.price);
    e.listings.length = Math.min(e.listings.length, LISTING_DEPTH);
  }

  return { book, bins };
}

/* ------------------------------------------------------------------ */
/* A present-tense price book                                          */
/* ------------------------------------------------------------------ */

/**
 * Same surface as PriceBook, priced at "now". costOf() takes either.
 *
 * The auction side is pre-filled rather than queried, because there is no way
 * to ask the auction API for one item — you read the whole book or nothing. See
 * craftPlan() for the two-pass fill.
 */
class LivePriceBook {
  constructor(bazaarPrices, bins) {
    this.prices = bazaarPrices;
    this.bins = bins;
    this.sources = new Map();

    this.bazaar = this.bazaar.bind(this);
    this.auction = this.auction.bind(this);
  }

  bazaar(itemId) {
    // NEU writes damage variants with a hyphen (INK_SACK-4); the bazaar uses a
    // colon (INK_SACK:4). Left unnormalised the lookup silently misses and the
    // ingredient reads as "not a bazaar item" (MARKET.md §4.3a).
    const id = itemId.replace(/-(\d+)$/, ':$1');

    // Forge recipes carry a literal coin cost as a pseudo-ingredient. It is not
    // a bazaar product, and without this it makes every recipe containing one
    // unpriceable (MARKET.md §4.3c).
    if (id === 'SKYBLOCK_COIN') return 1;

    const row = this.prices.get(id);
    if (!row) return null;

    // buy 0 with a non-zero sell is a real state — nobody is selling into buy
    // orders — and sell_price is much closer to what a purchase costs than 0.
    this.sources.set(itemId, 'live_bazaar');
    return row.buy > 0 ? row.buy : row.sell;
  }

  /**
   * `clean = true` asks for the price of the bare item. For the Etherwarp
   * Conduit and Merger no clean listing exists in the sense the flip pages mean
   * — they are consumables that are always listed as-is — so the two collapse.
   */
  auction(itemId, { clean = true } = {}) {
    const e = this.bins.get(itemId);
    if (!e) return null;
    const price = clean ? e.clean ?? e.any : e.any;
    if (price === null) return null;
    this.sources.set(itemId, 'live_auction');
    return price;
  }
}

/* ------------------------------------------------------------------ */
/* Cost tree                                                           */
/* ------------------------------------------------------------------ */

const nameOf = (itemId, meta) => meta.get(itemId)?.name ?? itemId;

/**
 * Coin totals cross the wire as whole coins (the contract in src/api/types.ts).
 * Bazaar unit prices are genuinely fractional and stay that way — plenty of
 * products trade under a coin — but every *total* is rounded.
 *
 * Rounding is per line and independent, so a parent can differ from the sum of
 * its children by a coin or two. That is preferred to deriving each parent from
 * its rounded children: a recipe with `count` above 1 divides by its output
 * count, and the children would then not sum to the parent by design.
 */
const whole = (n) => (n === null || n === undefined ? null : Math.round(n));

/**
 * Expand one item into the tree the UI renders.
 *
 * costOf() returns only its immediate parts (a sub-result's own breakdown is
 * discarded), so the children are re-costed here. That is free — the NEU
 * fetches are cached — and it keeps every node's number coming from costOf
 * rather than from a second, subtly different recursion.
 *
 * The stop condition mirrors costOf's exactly: below the root, anything that
 * trades on the bazaar is a leaf. Without that, a nested call at depth 0 would
 * happily expand ENCHANTED_DIAMOND's own recipe and report a craft cost costOf
 * never used.
 */
async function tree(itemId, quantity, book, meta, depth = 0) {
  const bz = book.bazaar(itemId);

  if (depth > 0 && bz !== null) {
    return {
      itemId,
      name: nameOf(itemId, meta),
      quantity,
      unitPrice: bz,
      totalPrice: whole(bz * quantity),
      via: 'bazaar',
      children: [],
    };
  }

  const c = await costOf(itemId, book);
  const children = [];
  for (const part of c.parts) {
    children.push(await tree(part.itemId, part.quantity, book, meta, depth + 1));
  }

  // The client recomputes craft cost as the caller opens and closes tiers, so
  // it needs the recipe's yield: a recipe producing 4 of something costs a
  // quarter of its ingredient sum per unit, and without this the client would
  // silently quadruple it. Cached — costOf just fetched the same item.
  const recipe = children.length > 0 ? parseRecipe(await fetchNeuItem(itemId)) : null;

  return {
    itemId,
    name: nameOf(itemId, meta),
    quantity,
    unitPrice: c.price,
    totalPrice: c.price === null ? null : whole(c.price * quantity),
    via: c.source, // 'craft' | 'bazaar' | 'auction' | null
    craftCost: whole(c.craftCost),
    marketPrice: whole(c.marketPrice),
    outputCount: recipe?.outputCount ?? 1,
    children,
  };
}

/** Every node in the tree whose price came back null. */
function unpricedIn(node, out = []) {
  if (node.unitPrice === null && node.children.length === 0) out.push(node.itemId);
  for (const c of node.children) unpricedIn(c, out);
  return out;
}

/** Every leaf id in the tree, so pass one knows what to look up on the AH. */
function idsIn(node, out = new Set()) {
  out.add(node.itemId);
  for (const c of node.children) idsIn(c, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Variants                                                            */
/* ------------------------------------------------------------------ */

/**
 * A finished item is not always one recipe. An Etherwarp Aspect of the Void is
 * three separate purchases — the sword, the Conduit applied to it, and the
 * Merger that fuses them — and only the first two have recipes at all.
 *
 * `requires` is a note, not a gate: the Conduit's recipe needs Enderman Slayer
 * 7, so for most accounts the AH price is the real cost even when crafting is
 * nominally cheaper. The UI shows both.
 */
const VARIANTS = {
  clean: {
    label: 'Clean',
    describe: (name) => `A bare ${name}, straight off the crafting grid.`,
    components: (itemId) => [{ key: 'base', itemId, quantity: 1 }],
  },
  etherwarp: {
    label: 'Etherwarp',
    describe: (name) => `${name} with Etherwarp — the sword, a Conduit, and the Merger that fuses them.`,
    components: (itemId) => [
      { key: 'base', itemId, quantity: 1 },
      { key: 'conduit', itemId: 'ETHERWARP_CONDUIT', quantity: 1, requires: 'Enderman Slayer 7' },
      { key: 'merger', itemId: 'ETHERWARP_MERGER', quantity: 1 },
    ],
  },
};

export const variantKeys = Object.keys(VARIANTS);

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Cost one finished item at current prices.
 *
 * Two passes, because the auction book cannot be queried per item. Pass one
 * prices everything the bazaar covers and records what it could not; pass two
 * scans the book for exactly those, plus the finished item itself, and re-costs.
 * The second pass is cheap — bazaar, NEU and book reads are all cached — and it
 * means a recipe reaching an auction-only ingredient we did not anticipate
 * still comes out priced instead of null.
 */
async function computePlan({ itemId = 'ASPECT_OF_THE_VOID', variant = 'etherwarp' } = {}) {
  const spec = VARIANTS[variant];
  if (!spec) {
    throw new Error(`Unknown variant "${variant}". Try one of: ${variantKeys.join(', ')}.`);
  }

  const [{ at: bazaarAt, prices }, meta] = await Promise.all([liveBazaar(), itemMetadata()]);
  const components = spec.components(itemId);

  /* ---- pass 1: bazaar only, to discover what needs the AH ---------- */

  const dry = new LivePriceBook(prices, new Map());
  const wanted = new Set([itemId]); // always price the finished item for comparison
  for (const c of components) {
    wanted.add(c.itemId);
    const node = await tree(c.itemId, c.quantity, dry, meta);
    for (const id of unpricedIn(node)) wanted.add(id);
    // An item with no recipe and no bazaar row is auction-only by definition.
    for (const id of idsIn(node)) if (dry.bazaar(id) === null) wanted.add(id);
  }

  /* ---- pass 2: fill from the live book, then cost for real --------- */

  const needles = [...wanted]
    .map((id) => nameOf(id, meta).toLowerCase())
    .filter((n) => n && n !== 'unknown');
  const { book: ahBook, bins } = await lowestBins(needles);

  const priceBook = new LivePriceBook(prices, bins);

  const priced = [];
  for (const c of components) {
    const node = await tree(c.itemId, c.quantity, priceBook, meta);
    const bin = bins.get(c.itemId) ?? null;
    const craftCost = node.craftCost ?? null;
    const marketPrice = whole(bin?.clean ?? bin?.any ?? null);

    // Cheapest way to actually obtain it. Craft wins ties: a recipe is a firm
    // price, whereas the lowest BIN is one listing that may be gone in a minute.
    let chosen = null;
    let cost = null;
    if (craftCost !== null && (marketPrice === null || craftCost <= marketPrice)) {
      chosen = 'craft';
      cost = craftCost;
    } else if (marketPrice !== null) {
      chosen = 'buy';
      cost = marketPrice;
    }
    // craftCost is already whole (tree() rounds it), so cost is too.

    /**
     * The listings behind the floor. `marketPrice` is one listing that may be
     * gone in a minute, so drop the exact one being costed and show what you
     * would actually pay next — that is the difference between a price and a
     * market. Matched by index, not by value, so identically-priced duplicates
     * are not all discarded.
     */
    const all = bin?.listings ?? [];
    const usedAt = all.findIndex((l) => l.price === marketPrice);
    const nextCheapest = all.filter((_, i) => i !== usedAt).slice(0, 10);

    priced.push({
      key: c.key,
      itemId: c.itemId,
      name: nameOf(c.itemId, meta),
      quantity: c.quantity,
      requires: c.requires ?? null,
      craftCost,
      marketPrice,
      marketListings: bin?.count ?? 0,
      chosen,
      cost,
      nextCheapest,
      unpriced: unpricedIn(node),
      tree: node,
    });
  }

  const unpriced = [...new Set(priced.flatMap((c) => c.unpriced))];
  const complete = priced.every((c) => c.cost !== null);

  // A partial sum understates cost and overstates profit, which is the
  // direction every trap in this project points. Null the total instead.
  const total = complete ? priced.reduce((n, c) => n + c.cost, 0) : null;
  const craftOnly = priced.every((c) => c.craftCost !== null)
    ? priced.reduce((n, c) => n + c.craftCost, 0)
    : null;

  /* ---- what the finished thing sells for --------------------------- */

  /**
   * The comparison has to be against the SAME item. The cheapest Aspect of the
   * Void on the book is a bare one; putting that next to an etherwarp build
   * prices two different swords against each other and makes crafting look
   * like a large loss. So the etherwarp variant compares against the cheapest
   * listing carrying `ethermerge`, and reports nothing when there is none.
   */
  const finished = bins.get(itemId) ?? null;
  const marketRef =
    variant === 'etherwarp' ? finished?.etherwarp ?? null : finished?.clean ?? finished?.any ?? null;
  const marketCount = variant === 'etherwarp' ? finished?.etherwarpCount ?? 0 : finished?.cleanCount ?? 0;

  return {
    itemId,
    itemName: nameOf(itemId, meta),
    rarity: meta.get(itemId)?.tier ?? 'COMMON',
    variant,
    variantLabel: spec.label,
    description: spec.describe(nameOf(itemId, meta)),
    generatedAt: new Date().toISOString(),
    components: priced,
    total,
    craftOnly,
    unpriced,
    market: {
      // Lowest BIN of the same thing this plan builds — an etherwarped sword
      // for the etherwarp variant, a bare one for clean.
      lowestBin: whole(marketRef),
      comparableListings: marketCount,
      // The bare sword, always, as context for the base component's buy option.
      cleanLowestBin: whole(finished?.clean ?? null),
      cleanListings: finished?.cleanCount ?? 0,
      listings: finished?.count ?? 0,
      // Positive means crafting is cheaper than the cheapest equivalent listing.
      savingsVsBuying: total !== null && marketRef !== null ? whole(marketRef) - total : null,
    },
    freshness: {
      // Absolute instants only. The *AgeSeconds fields are derived at serve
      // time by withAges(), because a cached plan that still claims "bazaar
      // read 2s ago" ten minutes later is the page lying about being live.
      bazaarAt: new Date(bazaarAt).toISOString(),
      auctionAt: new Date(ahBook.at).toISOString(),
      auctionsScanned: ahBook.scanned,
      auctionPages: ahBook.totalPages,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * A cold plan costs ~8s, almost all of it the 51-page auction sweep. The book
 * itself is already cached for 60s inside auctionBook(), which means a visitor
 * arriving more than a minute after the last one pays the full 8s — and on a
 * page nobody hammers, that is very nearly every visitor.
 *
 * So cache the finished plan and serve it stale while refreshing behind the
 * request. The 8s then lands on a background task instead of a person.
 */
const PLAN_FRESH_MS = 60_000; // serve untouched; matches the book's own TTL
const PLAN_STALE_MS = 10 * 60_000; // serve immediately, refresh behind it

/**
 * The key comes from ?item=, so it is caller-controlled. Bounded and evicted
 * oldest-first so a loop over made-up item ids cannot grow this without limit.
 * Well past the handful of real builds anyone asks for.
 */
const MAX_PLANS = 32;

const planCache = new Map(); // key -> { at, value }; insertion-ordered
const planInflight = new Map(); // key -> Promise

/**
 * Derive the age fields from the stored absolute instants.
 *
 * These cannot be baked into the cached object: it is handed to several
 * requests over several minutes, and each one needs the age as of *its* moment.
 */
function withAges(plan) {
  const now = Date.now();
  const age = (iso) => Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return {
    ...plan,
    freshness: {
      ...plan.freshness,
      bazaarAgeSeconds: age(plan.freshness.bazaarAt),
      auctionAgeSeconds: age(plan.freshness.auctionAt),
    },
  };
}

/** Compute once per key even if several requests arrive together. */
function computeShared(key, opts) {
  const pending = planInflight.get(key);
  if (pending) return pending;

  const p = computePlan(opts)
    .then((value) => {
      // Re-insert at the tail so a key that is still being used is not the one
      // evicted; Map iterates in insertion order.
      planCache.delete(key);
      planCache.set(key, { at: Date.now(), value });
      while (planCache.size > MAX_PLANS) {
        planCache.delete(planCache.keys().next().value);
      }
      return value;
    })
    .finally(() => planInflight.delete(key));

  planInflight.set(key, p);
  return p;
}

/**
 * Cost one finished item at current prices, cached.
 *
 * Fresh -> serve. Stale -> serve the old copy now and refresh behind it.
 * Older than PLAN_STALE_MS (or nothing cached) -> compute and wait, because
 * past that point the prices are too old to present as current.
 */
export async function craftPlan({ itemId = 'ASPECT_OF_THE_VOID', variant = 'etherwarp' } = {}) {
  const key = `${itemId}:${variant}`;
  const hit = planCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (hit && age < PLAN_FRESH_MS) return withAges(hit.value);

  if (hit && age < PLAN_STALE_MS) {
    // Fire and forget. A failed refresh must not reject this request or take
    // the process down as an unhandled rejection — the stale copy is still a
    // usable answer, and the next caller will try again.
    computeShared(key, { itemId, variant }).catch((err) =>
      console.error(`craft: background refresh of ${key} failed: ${err.message}`),
    );
    return withAges(hit.value);
  }

  return withAges(await computeShared(key, { itemId, variant }));
}
