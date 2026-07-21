import { readExtraAttributes, readTimestamp, detectUpgrades } from './items.js';
import { PriceBook, costOf, itemMetadata } from './prices.js';

/**
 * Turn a tracked_sales row into the FlipSummary / FlipDetail the frontend
 * contract specifies (BACKEND.md §1).
 *
 * The one invariant everything else serves:
 *   netProfit = salePrice − ahFees − costBasis    (NOT − baseItemCost)
 */

/**
 * Versioned so historical flips keep the rates that were in force when they
 * sold. These are the frontend mock's placeholders — BACKEND.md §8 flags them
 * as unverified against live game behaviour. Confirm in game before treating
 * fee figures as exact; the profit sign is unaffected at these magnitudes.
 */
const FEE_SCHEDULE = [
  {
    from: 0,
    tiers: [
      { min: 100_000_000, rate: 0.025, label: 'Claiming tax (2.5%)' },
      { min: 1_000_000, rate: 0.02, label: 'Claiming tax (2.0%)' },
      { min: 0, rate: 0.01, label: 'Claiming tax (1.0%)' },
    ],
    binListing: { rate: 0.001, label: 'BIN listing fee (0.1%)' },
  },
];

export function computeFees(salePrice, bin, soldAt) {
  const schedule = FEE_SCHEDULE.filter((s) => s.from <= soldAt).at(-1) ?? FEE_SCHEDULE[0];
  const tier = schedule.tiers.find((t) => salePrice >= t.min);

  const fees = [{ label: tier.label, amount: Math.round(salePrice * tier.rate) }];
  if (bin) {
    fees.push({
      label: schedule.binListing.label,
      amount: Math.round(salePrice * schedule.binListing.rate),
    });
  }
  return fees;
}

const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC', 'DIVINE', 'SPECIAL', 'VERY_SPECIAL'];

/**
 * Recombobulating bumps the displayed tier one step above the item's real one.
 * Reporting the bumped tier would misattribute the upgrade as intrinsic.
 */
function baseRarity(meta, ea) {
  const tier = meta?.tier ?? 'COMMON';
  if (!ea?.rarity_upgrades) return tier;
  const i = RARITIES.indexOf(tier);
  return i > 0 ? RARITIES[i - 1] : tier;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param row  a tracked_sales row
 * @param db   better-sqlite3 handle (for historical price lookups)
 * @param opts.detail  include ingredients/upgrades/metadata/fees
 */
export async function buildFlip(row, db, { detail = false } = {}) {
  const meta = (await itemMetadata()).get(row.item_id);

  let ea = null;
  if (row.item_bytes) {
    try {
      ea = await readExtraAttributes(row.item_bytes);
    } catch {
      /* corrupt NBT: fall through with no upgrades rather than dropping the sale */
    }
  }

  const craftedRaw = ea ? readTimestamp(ea) : null;
  const craftedAt = craftedRaw ?? row.crafted_at ?? row.sold_at;
  // No timestamp means we are pricing at sale time and calling the hold zero.
  const ageEstimated = craftedRaw === null && row.crafted_at === null;

  const book = new PriceBook(db, craftedAt);
  const upgrades = ea ? detectUpgrades(ea, meta) : [];

  /* ---- base item: craft cost first ---------------------------------- */
  const base = await costOf(row.item_id, book);
  // Craft cost is what the seller actually paid; a market price is only the
  // fallback for items with no recipe (and marks the flip as "bought").
  const baseItemCost = Math.round(base.price ?? 0);
  const acquisition = base.source === 'craft' ? 'crafted' : base.price !== null ? 'bought' : 'unknown';

  /* ---- upgrades ------------------------------------------------------ */
  let upgradeCost = 0;
  let unpricedUpgrades = 0;
  const upgradeLines = [];

  for (const u of upgrades) {
    let unit = null;
    let source = null;

    if (u.productId) {
      const bz = book.bazaar(u.productId);
      if (bz !== null) {
        unit = bz;
        source = 'own_snapshot';
      } else {
        // Etherwarp Conduit and friends never touch the bazaar; the recipe is
        // the honest basis and falls back to auction history inside costOf.
        const c = await costOf(u.productId, book);
        if (c.price !== null) {
          unit = c.price;
          source = c.source === 'craft' ? 'own_snapshot' : 'live_fallback';
        }
      }
    }

    if (unit === null) unpricedUpgrades += 1;
    else upgradeCost += unit * u.quantity;

    upgradeLines.push({
      kind: u.kind,
      label: u.label,
      quantity: u.quantity,
      unitPrice: unit === null ? null : Math.round(unit),
      totalPrice: unit === null ? null : Math.round(unit * u.quantity),
      source,
      note: u.note ?? null,
    });
  }

  upgradeCost = Math.round(upgradeCost);
  const costBasis = baseItemCost + upgradeCost;

  const fees = computeFees(row.price, !!row.bin, row.sold_at);
  const ahFees = fees.reduce((a, f) => a + f.amount, 0);
  const netProfit = row.price - ahFees - costBasis;

  const summary = {
    auctionUuid: row.auction_id,
    itemId: row.item_id,
    itemName: meta?.name ?? row.item_id,
    rarity: baseRarity(meta, ea),
    craftedAt: iso(craftedAt),
    soldAt: iso(row.sold_at),
    ageEstimated,
    acquisition,
    baseItemCost,
    upgradeCost,
    costBasis,
    unpricedUpgrades,
    salePrice: row.price,
    ahFees,
    netProfit,
    profitPct: costBasis > 0 ? +((netProfit / costBasis) * 100).toFixed(1) : 0,
    priceSource: book.worstSource(),
    bin: !!row.bin,
  };

  if (!detail) return summary;

  /* ---- detail-only fields -------------------------------------------- */
  const now = new PriceBook(db, Date.now());
  const current = await costOf(row.item_id, now);
  const names = await itemMetadata();

  return {
    ...summary,
    // We record the sale, not the listing; the ingest has no listed_at.
    listedAt: iso(row.sold_at),
    ingredients:
      acquisition === 'crafted'
        ? base.parts.map((p) => ({
            itemId: p.itemId,
            // Vanilla ingredients (NULL_OVOID, ENCHANTED_DIAMOND) are absent
            // from the SkyBlock item list; the raw id is the only name there is.
            name: names.get(p.itemId)?.name ?? p.itemId,
            quantity: p.quantity,
            unitPrice: p.unitPrice === null ? null : Math.round(p.unitPrice),
            totalPrice: p.unitPrice === null ? null : Math.round(p.unitPrice * p.quantity),
            source: p.unitPrice === null ? null : 'own_snapshot',
          }))
        : [],
    upgrades: upgradeLines,
    metadata: {
      itemId: row.item_id,
      name: meta?.name ?? row.item_id,
      tier: meta?.tier ?? null,
      category: meta?.category ?? null,
      npcSellPrice: meta?.npc_sell_price ?? null,
      starCosts: meta?.upgrade_costs ?? null,
      gemstoneSlots: meta?.gemstone_slots?.length ?? null,
    },
    fees,
    currentCraftCost: current.craftCost === null ? null : Math.round(current.craftCost),
    currentMarketPrice: current.marketPrice === null ? null : Math.round(current.marketPrice),
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export function rangeStart(range, now = Date.now()) {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  return days === undefined ? 0 : now - days * 86400_000;
}

export function summarize(flips) {
  const n = flips.length;
  const netProfit = flips.reduce((a, f) => a + f.netProfit, 0);
  const grossRevenue = flips.reduce((a, f) => a + f.salePrice, 0);

  // Hold time drives coins/hour. Flips with an estimated craft time have a
  // meaningless hold, so they are excluded from the denominator rather than
  // contributing a zero that inflates the rate to infinity.
  const holdHours = flips
    .filter((f) => !f.ageEstimated)
    .reduce((a, f) => a + (Date.parse(f.soldAt) - Date.parse(f.craftedAt)) / 3600_000, 0);

  const best = flips.reduce((b, f) => (b === null || f.netProfit > b.netProfit ? f : b), null);
  const confident = flips.filter((f) => f.priceSource === 'own_snapshot').length;

  return {
    netProfit,
    grossRevenue,
    totalBaseItemCost: flips.reduce((a, f) => a + f.baseItemCost, 0),
    totalUpgradeCost: flips.reduce((a, f) => a + f.upgradeCost, 0),
    totalCraftCost: flips.reduce((a, f) => a + f.costBasis, 0),
    totalFees: flips.reduce((a, f) => a + f.ahFees, 0),
    flipCount: n,
    winRatePct: n ? +((flips.filter((f) => f.netProfit > 0).length / n) * 100).toFixed(1) : 0,
    avgMarginPct: n ? +(flips.reduce((a, f) => a + f.profitPct, 0) / n).toFixed(1) : 0,
    coinsPerHour: holdHours > 0 ? Math.round(netProfit / holdHours) : 0,
    bestFlip: best,
    confidencePct: n ? +((confident / n) * 100).toFixed(1) : 0,
  };
}

/**
 * One point per day across the whole range, including days with no sales —
 * the chart plots by index and silently distorts if days are omitted.
 */
export function profitSeries(flips, fromMs, toMs = Date.now()) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const from = fromMs || Math.min(...flips.map((f) => Date.parse(f.soldAt)), toMs);

  const daily = new Map();
  for (const f of flips) daily.set(day(Date.parse(f.soldAt)), (daily.get(day(Date.parse(f.soldAt))) ?? 0) + f.netProfit);

  const out = [];
  let cumulative = 0;
  for (let t = Date.parse(day(from) + 'T00:00:00Z'); t <= toMs; t += 86400_000) {
    const d = day(t);
    cumulative += daily.get(d) ?? 0;
    out.push({ date: d, daily: daily.get(d) ?? 0, cumulative });
  }
  return out;
}

export function byItem(flips) {
  const groups = new Map();
  for (const f of flips) {
    const g = groups.get(f.itemId) ?? { itemId: f.itemId, itemName: f.itemName, flips: 0, netProfit: 0, revenue: 0, marginSum: 0 };
    g.flips += 1;
    g.netProfit += f.netProfit;
    g.revenue += f.salePrice;
    g.marginSum += f.profitPct;
    groups.set(f.itemId, g);
  }
  return [...groups.values()]
    .map(({ marginSum, ...g }) => ({ ...g, avgMarginPct: +(marginSum / g.flips).toFixed(1) }))
    .sort((a, b) => b.netProfit - a.netProfit);
}
