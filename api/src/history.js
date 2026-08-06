/**
 * Daily price-and-cost history for one item, PER BUILD.
 *
 * The version this replaces asked a question nobody wanted the answer to. It
 * charted the average sale price of *clean* Aspects of the Void — about 6M —
 * against a craft cost that was hardcoded `null` and therefore rendered as a
 * flat zero. So the page showed a 6M sword nobody crafts against a cost of
 * nothing, and called the difference margin.
 *
 * Both halves are fixed here, and both fixes turn on the same idea: a price and
 * a cost are only comparable when they describe the SAME item.
 *
 *   market side  Coflnet's sold feed, filtered to one exact upgrade set.
 *                price_rollup cannot do this — it keeps an is_clean flag and no
 *                upgrade detail, so it cannot tell an etherwarped sword from a
 *                recombobulated one (sales.js says the same thing at more
 *                length). Its wall is Coflnet's free-tier 7 days.
 *
 *   cost side    PriceBook at each day's noon, the same historical pricing the
 *                flip pages use, summed over that build's components. This
 *                reaches as far back as our own ingest does, which is further
 *                than 7 days and growing — hence the two sides having different
 *                spans and every series carrying nulls where it has nothing.
 *
 * ⚠ Coflnet requires ATTRIBUTION IN THE UI. The response carries it; render it.
 */

import { PriceBook, costOf, itemMetadata } from './prices.js';
import { cachedSold, matchesCohort, median } from './sales.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Prices for a day are read at its NOON, not its midnight. A day's line should
 * describe the day, and a boundary instant belongs equally to the day either
 * side of it. Today is read at "now" instead — noon has not happened yet on a
 * morning request, and PriceBook would answer from the future by falling
 * forward to the nearest snapshot it has.
 */
const anchorOf = (date) => Math.min(Date.parse(`${date}T12:00:00Z`), Date.now());

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * A readable name for an id the official item list does not carry.
 *
 * Enchantment books are the case that matters: `ENCHANTMENT_ULTIMATE_WISE_5` is
 * a real bazaar product and a real component of a build, but it is absent from
 * /resources/skyblock/items, so `meta.get()` misses and the raw id would be
 * what the page shows next to a price.
 */
function displayName(itemId, meta) {
  const known = meta.get(itemId)?.name;
  if (known) return known;

  const ench = /^ENCHANTMENT_(.+)_(\d+)$/.exec(itemId);
  const words = (s) =>
    s
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');

  if (ench) return `${words(ench[1])} ${ROMAN[Number(ench[2])] ?? ench[2]}`;
  return words(itemId);
}

/* ------------------------------------------------------------------ */
/* Builds                                                              */
/* ------------------------------------------------------------------ */

/**
 * A build is one row on the chart: a cohort on the market side and a bill of
 * materials on the cost side, and the two MUST describe the same sword.
 *
 * That constraint is what makes both cohorts `exact` rather than `contains`.
 * `contains ethermerge + Wise V` matches 415 sales in the last 7 days against
 * 110 for the exact form (measured 2026-08-05, 3,240 sales) — but most of that
 * extra volume carries tuners and gemstones, which the components below do not
 * pay for. Charting the cheaper bill against the dearer sword would invent
 * roughly 3M of margin that nobody can collect.
 *
 * The `enchantments` token is all-or-nothing in Coflnet's flattened shape, so
 * `exact` + Wise V cannot exclude a sword that ALSO carries Sharpness V. In
 * practice it nearly does: 99 of those 110 sales carried Ultimate Wise and
 * nothing else.
 *
 * `excludes` is redundant under `exact` and stated anyway — "and definitely not
 * recombobulated" is a claim this page makes, so it should be written down
 * rather than left as a consequence of the match mode.
 */
export const BUILDS = [
  {
    key: 'etherwarp',
    label: 'Etherwarp',
    describe: (name) => `${name} with the Conduit merged in, and nothing else on it.`,
    cohort: { match: 'exact', upgrades: ['ethermerge'], enchants: [], excludes: ['rarity_upgrades'] },
    components: [
      { itemId: 'ETHERWARP_CONDUIT', quantity: 1 },
      { itemId: 'ETHERWARP_MERGER', quantity: 1 },
    ],
  },
  {
    key: 'etherwarp_wise',
    label: 'Etherwarp + Wise V',
    describe: (name) => `${name} with Etherwarp and Ultimate Wise V. No recombobulator.`,
    cohort: {
      match: 'exact',
      upgrades: ['ethermerge'],
      enchants: [{ type: 'ultimate_wise', level: 5 }],
      excludes: ['rarity_upgrades'],
    },
    components: [
      { itemId: 'ETHERWARP_CONDUIT', quantity: 1 },
      { itemId: 'ETHERWARP_MERGER', quantity: 1 },
      { itemId: 'ENCHANTMENT_ULTIMATE_WISE_5', quantity: 1 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Cost side                                                           */
/* ------------------------------------------------------------------ */

/**
 * Components priced from what a tracked player actually paid, not from the
 * market — see PriceBook.ownBuyMean().
 *
 * Scoped to this book rather than set globally on PriceBook, because the two
 * callers of that class ask different questions. This chart asks "what does it
 * cost US to build one", so our own purchase price is the right answer and a
 * day we bought no Merger has no answer at all. flips.js asks what a specific
 * historical flip cost, and nulling a Merger there because the craft happened
 * more than a day after the purchase would make ordinary flips unpriceable.
 *
 * The consequence is on-screen and intended: an Etherwarp Merger is bought a
 * handful of times a week, so the craft cost lines are null on every day
 * without a purchase, and the chart draws them as gaps.
 */
const OWN_BUY_PRICED = ['ETHERWARP_MERGER'];

/**
 * What one unit of an applied upgrade cost at `book`'s moment.
 *
 * Deliberately the same two-step flips.js uses on every upgrade line: bazaar
 * first, then costOf — which prefers the recipe and falls back to auction
 * history. An Etherwarp Conduit is craftable and a Merger is not, so the two
 * come out of different branches of that, and reimplementing the order here is
 * how this page and the flips table start disagreeing about the same sword.
 *
 * A bazaar price of 0 is a real state (both sides of the book empty) and is
 * returned as-is, not treated as a miss.
 */
async function upgradeCost(itemId, book) {
  const bz = book.bazaar(itemId);
  if (bz !== null) return bz;
  const c = await costOf(itemId, book);
  return c.price;
}

/**
 * Every build's craft cost on one day.
 *
 * The base item is costed from its RECIPE only — `craftCost`, not `price`. The
 * fallback inside `price` is the item's own market price, and a "craft cost"
 * line that quietly becomes "what a finished one goes for" on the days the
 * recipe cannot be priced is the same class of error this module exists to fix.
 *
 * Any unpriceable part nulls the whole build for that day. A partial sum
 * understates cost and overstates margin, which is the direction every trap in
 * this project points (MARKET.md §4.3b).
 */
async function costOnDay(db, itemId, date) {
  const book = new PriceBook(db, anchorOf(date), { ownBuys: OWN_BUY_PRICED });

  const base = await costOf(itemId, book);
  const baseCost = base.craftCost;

  // Distinct across builds, priced once: the Conduit and Merger appear in both.
  const parts = new Map();
  for (const b of BUILDS) {
    for (const c of b.components) {
      if (!parts.has(c.itemId)) parts.set(c.itemId, await upgradeCost(c.itemId, book));
    }
  }

  const out = new Map();
  for (const b of BUILDS) {
    let total = baseCost;

    for (const c of b.components) {
      const unit = parts.get(c.itemId) ?? null;
      if (unit === null || total === null) total = null;
      else total += unit * c.quantity;
    }

    out.set(b.key, {
      craftCost: total === null ? null : Math.round(total),
      /**
       * True when at least one ingredient had no snapshot near this day and was
       * priced from the nearest one we hold. Early days in the window are the
       * usual cause — our own history simply does not reach that far — and the
       * number is an estimate rather than a reading. Flagged, not hidden.
       */
      estimated: book.worstSource() === 'live_fallback',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Series                                                              */
/* ------------------------------------------------------------------ */

/**
 * How far back to chart. The cost side can reach as far as our own ingest, and
 * every extra day is another pass of recipe recursion, so it is capped rather
 * than unbounded.
 */
const MAX_DAYS = 30;

/** Coflnet's free tier serves exactly this much of the sold feed. */
const MARKET_DAYS = 7;

/**
 * The days to chart: every day our own rollup holds a sale of this item, plus
 * every day Coflnet reaches. The two spans differ by design — see the header —
 * so the union is taken and each series carries null where it has nothing,
 * rather than the whole chart being trimmed to the shorter of the two.
 */
function windowDays(db, itemId, marketDates) {
  const floor = dayOf(Date.now() - (MAX_DAYS - 1) * DAY_MS);
  const local = [];

  try {
    const row = db
      .prepare('SELECT MIN(hour) AS lo, MAX(hour) AS hi FROM price_rollup WHERE item_id = ?')
      .get(itemId);

    if (row?.lo != null) {
      // UTC has no DST, so a fixed 24h step lands on the same clock time every
      // day and visits each calendar day exactly once. The half-day overshoot
      // covers a range that is not a whole number of days; the filter trims it.
      const last = dayOf(row.hi * HOUR_MS);
      for (let t = row.lo * HOUR_MS; t <= row.hi * HOUR_MS + DAY_MS; t += DAY_MS) {
        const d = dayOf(t);
        if (d <= last) local.push(d);
      }
    }
  } catch {
    /* no rollup for this item yet — the market side alone still charts */
  }

  const all = new Set([...local, ...marketDates].filter((d) => d >= floor));
  return [...all].sort();
}

/**
 * Daily median sale price per build, from the Coflnet feed.
 *
 * Median, not mean: one 90M sale of a sword somebody overpaid for should not
 * move the day. `sales` rides along on every point so a thin day can be read as
 * thin instead of as a price move — the exact cohorts here match tens of sales
 * a day, not hundreds.
 */
function marketByDay(sales, cohort) {
  const matched = sales.filter((s) => matchesCohort(s, cohort));
  const byDay = new Map();
  for (const s of matched) {
    const d = dayOf(s.soldAt);
    const bucket = byDay.get(d) ?? [];
    bucket.push(s.highestBidAmount ?? 0);
    byDay.set(d, bucket);
  }
  return { byDay, total: matched.length };
}

/**
 * The item's price and cost history, one series pair per build.
 *
 * Two data sources with two different reaches, one shared date axis, nulls
 * wherever a series has nothing to say for a day.
 */
export async function itemSeries({ db, itemId }) {
  const [meta, sold] = await Promise.all([
    itemMetadata(),
    cachedSold({ itemId, days: MARKET_DAYS }).catch((err) => {
      // Coflnet being down must not take the cost side with it. The page then
      // draws craft cost alone, and `coverage.marketError` says why.
      console.error(`history: Coflnet fetch for ${itemId} failed: ${err.message}`);
      return { sales: [], pages: 0, truncated: false, fetchedAt: Date.now(), error: err.message };
    }),
  ]);

  const nameOf = (id) => displayName(id, meta);
  const itemName = nameOf(itemId);
  const today = dayOf(Date.now());

  const market = BUILDS.map((b) => marketByDay(sold.sales, b.cohort));
  const marketDates = new Set();
  for (const m of market) for (const d of m.byDay.keys()) marketDates.add(d);

  const dates = windowDays(db, itemId, marketDates);

  // One PriceBook per day, shared by every build — the recursion below it is
  // where the cost lives, and running it per build would repeat all of it.
  const costs = new Map();
  for (const date of dates) costs.set(date, await costOnDay(db, itemId, date));

  const builds = BUILDS.map((b, i) => {
    const { byDay, total } = market[i];

    const points = dates.map((date) => {
      const cost = costs.get(date)?.get(b.key);
      const prices = byDay.get(date) ?? [];
      return {
        date,
        marketPrice: median(prices),
        sales: prices.length,
        craftCost: cost?.craftCost ?? null,
        estimated: cost?.estimated ?? false,
        /**
         * Today is a fraction of a day, and these cohorts match tens of sales a
         * day — so the last point is routinely a median of one or two. Flagged
         * rather than dropped: the day is real, its median just is not a day's
         * worth of evidence, and an unmarked single 28M sale reads as a spike.
         */
        partial: date === today,
      };
    });

    // The newest day with both numbers, preferring a day that is over. Reading
    // "latest" off today would headline a median of one sale; a day where one
    // side is missing would put a spread next to a blank.
    const priced = points.filter((p) => p.marketPrice !== null && p.craftCost !== null);
    const latest = [...priced].reverse().find((p) => !p.partial) ?? priced[priced.length - 1] ?? null;

    return {
      key: b.key,
      label: b.label,
      description: b.describe(itemName),
      cohort: {
        match: b.cohort.match,
        upgrades: b.cohort.upgrades,
        excludes: b.cohort.excludes ?? [],
        enchants: b.cohort.enchants ?? [],
      },
      components: [
        { itemId, name: itemName, quantity: 1 },
        ...b.components.map((c) => ({ itemId: c.itemId, name: nameOf(c.itemId), quantity: c.quantity })),
      ],
      points,
      salesMatched: total,
      latest: latest
        ? {
            date: latest.date,
            marketPrice: latest.marketPrice,
            craftCost: latest.craftCost,
            spread: latest.marketPrice - latest.craftCost,
            marginPct: latest.craftCost > 0 ? +(((latest.marketPrice - latest.craftCost) / latest.craftCost) * 100).toFixed(1) : null,
          }
        : null,
      // Days where crafting one was cheaper than the going rate, out of the days
      // both numbers exist for. A ratio against the whole window would count the
      // days we cannot answer for as days crafting lost.
      profitableDays: priced.filter((p) => p.marketPrice > p.craftCost).length,
      comparableDays: priced.length,
    };
  });

  return {
    itemId,
    itemName,
    rarity: meta.get(itemId)?.tier ?? 'COMMON',
    dates,
    builds,
    coverage: {
      marketDays: MARKET_DAYS,
      marketFrom: sold.sales.length ? new Date(sold.sales[0].soldAt).toISOString() : null,
      marketTo: sold.sales.length ? new Date(sold.sales[sold.sales.length - 1].soldAt).toISOString() : null,
      salesScanned: sold.sales.length,
      truncated: !!sold.truncated,
      marketError: sold.error ?? null,
      // Absolute instant; the age is derived at serve time so a cached feed
      // cannot keep claiming it was read seconds ago.
      fetchedAt: new Date(sold.fetchedAt).toISOString(),
      costEstimatedDays: dates.filter((d) => costs.get(d)?.get(BUILDS[0].key)?.estimated).length,
    },
    attribution: 'Sales data from Coflnet — sky.coflnet.com',
  };
}
