/**
 * Sales volume by exact upgrade set.
 *
 * "How many Aspect of the Voids sold with etherwarp and NOTHING else" is a
 * question neither local store can answer. price_rollup keeps an is_clean flag
 * and no upgrade detail, so it cannot separate an etherwarp-only sword from a
 * recombobulated one; tracked_sales has the full NBT but only for the two
 * tracked players. Both are the wrong shape for a server-wide cohort count.
 *
 * Coflnet can: its sold-auction feed returns `flattenedNbt` already parsed, so
 * every sale's upgrade set is readable without decoding a byte of NBT.
 * MARKET.md §8.2 documents the endpoint and its limits.
 *
 * ⚠ Coflnet requires ATTRIBUTION IN THE UI, and commercial use requires
 * Premium+. The frontend renders it; do not remove it.
 */

const COFL = 'https://sky.coflnet.com/api';

/**
 * Free tier serves a hard 7-day window in pages of up to 1000. Measured on
 * 2026-07-26: Aspect of the Void returns a full 1000 per page covering only
 * ~2.4 days, so a week needs several pages. Capped so a high-volume item cannot
 * spin this forever.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 8;

/** Sequential with a gap: the documented limit is 30 req/10s, 100/min per IP. */
const PAGE_GAP_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Upgrade classification                                              */
/* ------------------------------------------------------------------ */

/**
 * Cost-bearing keys AS COFLNET FLATTENS THEM.
 *
 * This is deliberately NOT decode.js's UPGRADE_KEYS. Coflnet's flattened shape
 * uses different names for the same things — hot potato books arrive as `hpc`,
 * not `hot_potato_count`; dungeon stars as `dungeon_item`, not
 * `dungeon_item_level` — and enchantments are not in the map at all, they are a
 * separate top-level array. Reusing the raw-NBT list here would silently
 * classify a starred, hot-potatoed sword as "clean", which is exactly the class
 * of error MARKET.md §3.1 is about.
 *
 * Gems and runes are matched by shape rather than listed: gemstone slots arrive
 * as SAPPHIRE_0 / RUBY_1 and runes as RUNE_<NAME>, both open-ended sets.
 */
const FLAT_UPGRADE_KEYS = new Set([
  'ethermerge',
  'rarity_upgrades',
  'tuned_transmission',
  'ability_scroll',
  'power_ability_scroll',
  'art_of_war_count',
  'hpc',
  'dungeon_item',
  'modifier',
  'skin',
  'dye_item',
  'upgrade_level',
  'talisman_enrichment',
  'mana_disintegrator_count',
  'wood_singularity_count',
  'farming_for_dummies_count',
]);

/** SAPPHIRE_0, RUBY_1, COMBAT_0 … a gemstone socketed into a slot. */
const GEM_SLOT = /^[A-Z]+_\d+$/;
const RUNE = /^RUNE_/;

/**
 * Keys seen on real sales that cost nothing — identity, counters, cosmetics.
 * Anything NOT here and not a known upgrade is reported as unclassified rather
 * than assumed free, per MARKET.md §3.1: a missing key does not fail loudly, it
 * books the upgrade as profit.
 */
const KNOWN_FREE = new Set([
  'uid',
  'uuid',
  'champion_combat_xp',
  'stats_book',
  'timestamp',
  'originTag',
  'bossId',
  'item_tier',
  'baseStatBoostPercentage',
  'anvil_uses',
  'favorite_gemstone',
  'color',
  'cc',
]);

/** The cost-bearing upgrade set of one Coflnet sale, sorted and deduped. */
export function upgradeSetOf(auction) {
  const flat = auction?.flattenedNbt ?? {};
  const set = new Set();

  for (const key of Object.keys(flat)) {
    if (FLAT_UPGRADE_KEYS.has(key)) set.add(key);
    else if (RUNE.test(key)) set.add('runes');
    // A gem slot key carries a ".uuid" sibling; both mean one gem.
    else if (GEM_SLOT.test(key.split('.')[0]) && !KNOWN_FREE.has(key)) set.add('gems');
  }

  // Not part of flattenedNbt — Coflnet returns these as their own array.
  if (Array.isArray(auction?.enchantments) && auction.enchantments.length > 0) set.add('enchantments');

  return [...set].sort();
}

/**
 * Highest level seen per enchantment. Coflnet returns these as their own array,
 * not inside flattenedNbt, and an item can list the same enchant once — the max
 * is taken anyway so a malformed duplicate cannot understate a requirement.
 */
export function enchantLevelsOf(auction) {
  const out = new Map();
  for (const e of auction?.enchantments ?? []) {
    if (!e?.type) continue;
    const lvl = Number(e.level ?? 0);
    if (lvl > (out.get(e.type) ?? -1)) out.set(e.type, lvl);
  }
  return out;
}

/** Keys we could not classify either way, so they can be surfaced, not ignored. */
export function unclassifiedKeysOf(auction) {
  const flat = auction?.flattenedNbt ?? {};
  const out = [];
  for (const key of Object.keys(flat)) {
    const head = key.split('.')[0];
    if (FLAT_UPGRADE_KEYS.has(key) || RUNE.test(key) || GEM_SLOT.test(head)) continue;
    if (KNOWN_FREE.has(key) || KNOWN_FREE.has(head)) continue;
    out.push(key);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                             */
/* ------------------------------------------------------------------ */

/**
 * A cohort matches either way:
 *
 *   exact    — this upgrade set and nothing else. The bare-sword baseline.
 *   contains — at least these upgrades; anything extra is allowed.
 *
 * The two modes answer different questions and the difference is not cosmetic.
 * `exact` on a built sword is a trap: measured over 2,000 sales on 2026-07-26,
 * `ethermerge + rarity_upgrades` exactly occurs ZERO times, because every
 * recombobulated Aspect of the Void is also enchanted and usually tuned. That
 * is a true statement about a product nobody sells, which makes it useless as a
 * volume series — hence `contains` for the built cohort.
 *
 * `enchants` is a floor, not an equality: Wise V matches a sword that also has
 * Sharpness VI. Enchantments live outside flattenedNbt, so they are required
 * separately from the upgrade keys.
 *
 * Measured over the same 2,000 sales: etherwarp + tuner + gems returns 112,
 * and ALL 112 already carry Ultimate Wise V — at this tier the enchant is
 * implied by the build rather than a filter that narrows it.
 */
export const COHORTS = [
  {
    key: 'ethermerge',
    label: 'Etherwarp only',
    match: 'exact',
    upgrades: ['ethermerge'],
    enchants: [],
  },
  {
    key: 'ethermerge_built',
    label: 'Etherwarp + tuner + gems + Wise V',
    match: 'contains',
    upgrades: ['ethermerge', 'tuned_transmission', 'gems'],
    enchants: [{ type: 'ultimate_wise', level: 5 }],
  },
];

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Does one sale belong to `cohort`? */
function matches(sale, cohort) {
  const levels = enchantLevelsOf(sale);
  for (const e of cohort.enchants ?? []) {
    if ((levels.get(e.type) ?? -1) < e.level) return false;
  }

  const have = upgradeSetOf(sale);
  const want = [...cohort.upgrades].sort();

  if (cohort.match === 'contains') return want.every((u) => have.includes(u));

  // Exact mode still has to account for the enchantments token: a cohort that
  // requires an enchant is asking for a sword that HAS enchantments, so the
  // token belongs in the expected set rather than disqualifying every match.
  const expected = cohort.enchants?.length ? [...new Set([...want, 'enchantments'])].sort() : want;
  return sameSet(have, expected);
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

async function soldPage(tag, page) {
  const url = `${COFL}/auctions/tag/${encodeURIComponent(tag)}/sold?page=${page}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Coflnet returned ${res.status} on ${tag} page ${page}.`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

/**
 * Every sale of `tag` inside the window, deduped by auction uuid.
 *
 * Stops on the first empty page (the free tier's 7-day wall returns [], not an
 * error), once a page's oldest sale predates the window, or at MAX_PAGES.
 */
async function fetchSold(tag, sinceMs) {
  const byUuid = new Map();
  let pages = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_GAP_MS);
    const rows = await soldPage(tag, page);
    pages += 1;
    if (rows.length === 0) break;

    let oldest = Infinity;
    for (const row of rows) {
      // Coflnet stamps `end` without a zone; it is UTC.
      const t = Date.parse(row.end?.endsWith('Z') ? row.end : `${row.end}Z`);
      if (!Number.isFinite(t)) continue;
      oldest = Math.min(oldest, t);
      if (t >= sinceMs) byUuid.set(row.uuid, { ...row, soldAt: t });
    }

    if (oldest <= sinceMs) break; // this page already crossed the window
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { sales: [...byUuid.values()].sort((a, b) => a.soldAt - b.soldAt), pages, truncated };
}

/* ------------------------------------------------------------------ */
/* Series                                                              */
/* ------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;

/** The UTC hour a sale falls in, as a parseable stamp: 2026-07-26T14:00:00Z. */
const hourOf = (ms) => `${new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13)}:00:00Z`;

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Hourly sales volume per cohort.
 *
 * Every hour in the window gets a point, including empty ones. Dropping them
 * would make a cohort that stopped selling look like it merely stopped being
 * measured, and would misdraw the gap between the hours either side.
 *
 * The window is a whole number of clock hours ending with the one in progress,
 * so `since` is the first bucket's start rather than exactly `days` ago — a
 * ragged first bucket would silently undercount its own hour. The last bucket
 * is genuinely partial and is flagged, not hidden: at hour resolution the
 * current hour is always a fraction of a bar and reads as a crash if unmarked.
 */
export async function salesVolume({ itemId = 'ASPECT_OF_THE_VOID', days = 7 } = {}) {
  const now = Date.now();
  const hours = days * 24;
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const since = currentHour - (hours - 1) * HOUR_MS;

  const { sales, pages, truncated } = await fetchSold(itemId, since);

  const hourKeys = [];
  for (let i = 0; i < hours; i++) hourKeys.push(hourOf(since + i * HOUR_MS));
  const openHour = hourOf(currentHour);

  const cohorts = COHORTS.map((c) => {
    const matched = sales.filter((s) => matches(s, c));

    const byHour = new Map(hourKeys.map((h) => [h, []]));
    for (const s of matched) {
      const bucket = byHour.get(hourOf(s.soldAt));
      if (bucket) bucket.push(s.highestBidAmount ?? 0);
    }

    return {
      key: c.key,
      label: c.label,
      match: c.match,
      upgrades: c.upgrades,
      enchants: c.enchants,
      sales: matched.length,
      medianPrice: median(matched.map((s) => s.highestBidAmount ?? 0)),
      points: hourKeys.map((hour) => {
        const prices = byHour.get(hour) ?? [];
        return {
          hour,
          sales: prices.length,
          medianPrice: median(prices),
          partial: hour === openHour,
        };
      }),
    };
  });

  // What the cohorts exclude, so a zero series can be explained rather than
  // just shown. Ranked, top few only.
  const shapes = new Map();
  for (const s of sales) {
    const sig = upgradeSetOf(s).join('+') || '(clean)';
    shapes.set(sig, (shapes.get(sig) ?? 0) + 1);
  }
  const topShapes = [...shapes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([upgrades, sales]) => ({ upgrades, sales }));

  const unclassified = new Set();
  for (const s of sales) for (const k of unclassifiedKeysOf(s)) unclassified.add(k);

  return {
    itemId,
    itemName: sales[0]?.itemName ?? itemId,
    days,
    hours,
    generatedAt: new Date(now).toISOString(),
    cohorts,
    coverage: {
      salesScanned: sales.length,
      pagesFetched: pages,
      truncated,
      from: sales.length ? new Date(sales[0].soldAt).toISOString() : null,
      to: sales.length ? new Date(sales[sales.length - 1].soldAt).toISOString() : null,
    },
    topShapes,
    // Empty is the healthy state. A key here is a possible cost-bearing upgrade
    // nobody has classified yet — see MARKET.md §3.1.
    unclassifiedKeys: [...unclassified].sort(),
    attribution: 'Sales data from Coflnet — sky.coflnet.com',
  };
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * Several sequential Coflnet pages per call, against a rate-limited third
 * party. Same stale-while-revalidate shape as craft.js: serve the cached
 * series and refresh behind the request, so a visitor never waits on Coflnet
 * and we never hammer it.
 *
 * Five minutes is short relative to the hour a bar covers, so the only bar a
 * stale serve can understate is the one still filling — which the point marks
 * as partial anyway.
 */
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_ENTRIES = 16; // ?item= is caller-controlled

const cache = new Map();
const inflight = new Map();

function shared(key, opts) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = salesVolume(opts)
    .then((value) => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

export async function cachedSalesVolume({ itemId = 'ASPECT_OF_THE_VOID', days = 7 } = {}) {
  const key = `${itemId}:${days}`;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  const stamp = (v) => ({ ...v, cachedAgeSeconds: Math.round((Date.now() - (hit?.at ?? Date.now())) / 1000) });

  if (hit && age < FRESH_MS) return stamp(hit.value);

  if (hit && age < STALE_MS) {
    shared(key, { itemId, days }).catch((err) =>
      console.error(`sales: background refresh of ${key} failed: ${err.message}`),
    );
    return stamp(hit.value);
  }

  const fresh = await shared(key, { itemId, days });
  return { ...fresh, cachedAgeSeconds: 0 };
}
