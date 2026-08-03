import { readExtraAttributes, readTimestamp, detectUpgrades } from './items.js';
import { PriceBook, costOf, itemMetadata, reforgeTables } from './prices.js';

/**
 * Turn a tracked_sales row into the FlipSummary / FlipDetail the frontend
 * contract specifies (BACKEND.md §1).
 *
 * The one invariant everything else serves:
 *   netProfit = salePrice − ahFees − costBasis    (NOT − baseItemCost)
 */

/**
 * Two separate charges, and it is the LISTING fee that is tiered — not the
 * claim tax. An earlier version had this inverted (tiered tax at a 1M
 * boundary, flat 0.1% listing), which understated fees on everything above
 * 10M.
 *
 *   claim tax     flat 1% of the sale, taken when you collect the coins
 *   listing fee   1% under 10M, 2% from 10M to 100M, 2.5% above 100M
 *
 * Versioned by effective date so historical flips keep the rates that were in
 * force when they sold — Hypixel has changed AH fees before, and a single
 * hardcoded rate silently corrupts old figures the next time they do.
 */
const FEE_SCHEDULE = [
  {
    from: 0,
    claimTax: { rate: 0.01, label: 'Claiming tax (1.0%)' },
    listingTiers: [
      { min: 100_000_000, rate: 0.025, label: 'Listing fee (2.5%)' },
      { min: 10_000_000, rate: 0.02, label: 'Listing fee (2.0%)' },
      { min: 0, rate: 0.01, label: 'Listing fee (1.0%)' },
    ],
  },
];

/**
 * The listing fee is charged on the price you LIST at, not the price it sells
 * for. For BIN those are the same number. For a bidding auction the starting
 * bid is usually lower than the hammer price, and we do not record it — so
 * this overstates the fee on non-BIN sales. Every tracked flip so far is BIN.
 */
export function computeFees(salePrice, bin, soldAt) {
  const schedule = FEE_SCHEDULE.filter((s) => s.from <= soldAt).at(-1) ?? FEE_SCHEDULE[0];
  const tier = schedule.listingTiers.find((t) => salePrice >= t.min);

  return [
    { label: schedule.claimTax.label, amount: Math.round(salePrice * schedule.claimTax.rate) },
    {
      label: bin ? tier.label : `${tier.label}, estimated on sale price`,
      amount: Math.round(salePrice * tier.rate),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */

/**
 * Did this player buy this exact item before selling it?
 *
 * The join key is the item's own NBT uuid, which survives the trade: the same
 * physical sword carries it into the buyer's inventory and back onto the AH.
 * item_id would match thousands of unrelated swords, so it is not enough.
 *
 * Three conditions, all load-bearing:
 *   same uuid     the same physical item, not merely the same kind of item
 *   same player   buyer of the purchase IS the seller of this sale
 *   bought before a purchase after the sale is a RE-acquisition of an item they
 *                 sold, and pricing this sale from it would be time travel
 *
 * The most recent qualifying purchase wins: an item can go through the same
 * player more than once, and the relevant basis is what they paid for it the
 * last time they got it.
 */
function findPurchase(db, itemUuid, seller, soldAt) {
  if (!itemUuid || !seller) return null;

  try {
    return (
      db
        .prepare(
          `SELECT auction_id, price, bought_at, item_bytes FROM tracked_buys
            WHERE item_uuid = ? AND buyer = ? AND bought_at <= ?
            ORDER BY bought_at DESC LIMIT 1`,
        )
        .get(itemUuid, seller, soldAt) ?? null
    );
  } catch {
    // The API and the ingest deploy separately, so an API running ahead of the
    // ingest meets a database with no tracked_buys table. That is "no purchases
    // recorded yet", not an error — every flip falls back to craft cost, which
    // is exactly the behaviour before this feature existed.
    return null;
  }
}

/**
 * Upgrades present on the item at the moment it was BOUGHT.
 *
 * These are already inside the purchase price and must not be charged again:
 * a sword bought with Sharpness VI and resold untouched costs what was paid for
 * it, full stop. Only what the player added afterwards is new cost.
 *
 * Keyed by label because that is what identifies an upgrade to a reader, and
 * what detectUpgrades produces on both sides from the same code path.
 */
async function upgradesAtPurchase(itemBytes, meta, reforges) {
  if (!itemBytes) return null; // unknown, so charge nothing away — see the caller

  try {
    const ea = await readExtraAttributes(itemBytes);
    if (!ea) return null;
    return new Set(detectUpgrades(ea, meta, reforges).map((u) => u.label));
  } catch {
    return null; // corrupt NBT: fall back to charging every upgrade
  }
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
  const [names, reforges] = await Promise.all([itemMetadata(), reforgeTables()]);
  const meta = names.get(row.item_id);

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

  /* ---- base item: what they actually paid, if we know it ------------- */

  /**
   * A recorded purchase of this exact item outranks every computed price.
   * costOf answers "what would this cost to obtain?"; a purchase row answers
   * "what did it cost", and on a resell those are different numbers — the
   * whole point of buying is that you paid less than it was worth.
   */
  const purchase = findPurchase(db, ea?.uuid ?? null, row.seller, row.sold_at);

  // Skipped entirely when we have a purchase: its answer would not be used, and
  // its lookups would drag `priceSource` down to reflect a price nobody paid.
  const base = purchase ? null : await costOf(row.item_id, book);

  // Craft cost is what the seller actually paid; a market price is only the
  // fallback for items with no recipe (and marks the flip as "bought").
  const baseItemCost = purchase ? purchase.price : Math.round(base.price ?? 0);
  const acquisition = purchase
    ? 'bought'
    : base.source === 'craft'
      ? 'crafted'
      : base.price !== null
        ? 'bought'
        : 'unknown';

  /* ---- upgrades ------------------------------------------------------ */

  /**
   * Upgrades that came WITH the item are already inside the purchase price;
   * charging them again would bill the same Sharpness VI twice. Only what was
   * added after buying is new cost.
   *
   * A null set (no stored NBT, or NBT we could not read) charges every upgrade
   * — overstating cost rather than profit, which is the only direction this
   * project is willing to be wrong in.
   */
  const atPurchase = purchase ? await upgradesAtPurchase(purchase.item_bytes, meta, reforges) : null;
  const upgrades = (ea ? detectUpgrades(ea, meta, reforges) : []).filter((u) => !atPurchase?.has(u.label));

  let upgradeCost = 0;
  let unpricedUpgrades = 0;
  const upgradeLines = [];

  for (const u of upgrades) {
    // A fixed price is known without a lookup — an anvil reforge consumes no
    // item, so its zero is measured, not missing, and must not land in
    // unpricedUpgrades.
    let unit = u.fixedPrice ?? null;
    let source = null;

    if (unit === null && u.productId) {
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
    /**
     * A purchase price is not an estimate — it is the recorded number. With no
     * upgrades to look up, nothing about this flip was inferred, and letting
     * worstSource() report its empty state as `live_fallback` would flag the
     * most certain flips we have as the least trustworthy.
     */
    priceSource: purchase && book.sources.size === 0 ? 'own_snapshot' : book.worstSource(),
    bin: !!row.bin,
    /**
     * Set only when this item was bought by this player and resold. Its presence
     * is what says "cost basis is a price paid, not a price computed" — which
     * is a different kind of number and is surfaced as such.
     */
    purchase: purchase
      ? {
          auctionUuid: purchase.auction_id,
          price: purchase.price,
          boughtAt: iso(purchase.bought_at),
        }
      : null,
  };

  if (!detail) return summary;

  /* ---- detail-only fields -------------------------------------------- */
  const now = new PriceBook(db, Date.now());
  const current = await costOf(row.item_id, now);

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

/**
 * Price a still-in-flight auction the same way buildFlip prices a sold one:
 * projected sale price − fees − craft cost. It reuses buildFlip verbatim by
 * building a synthetic tracked_sales row, so the number a listing shows here is
 * the number it will show in the history once it sells.
 *
 * playerAuctions returns UNCLAIMED auctions, which is a mix of three states:
 *   active   end in the future, no buyer yet — will sell if a buyer comes
 *   sold     ended with a buyer, coins waiting to be claimed — effectively banked
 *   expired  ended with no buyer — the item returns, no sale happens
 * Only active + sold are "expected profit"; expired is reported but excluded.
 */
export async function buildPending(auction, db) {
  const bin = !!auction.bin;
  const end = Number(auction.end ?? Date.now());
  const topBid = Number(auction.highest_bid_amount ?? 0);
  const listPrice = Number(auction.starting_bid ?? 0);
  const status = end > Date.now() ? 'active' : topBid > 0 ? 'sold' : 'expired';

  // BIN sells at its list price; an open auction at the current top bid, or the
  // opening bid if nobody has bid yet — optimistic, but it is the only number
  // there is until the hammer falls.
  const expectedSale = bin ? listPrice : Math.max(topBid, listPrice);

  // The player-auctions endpoint gives item_bytes as an OBJECT — {type, data}
  // with the gzipped-NBT base64 under .data — whereas the ingest stores (and
  // readExtraAttributes/buildFlip expect) the base64 string on its own. Feeding
  // the object to Buffer.from(...,'base64') decodes to garbage, the NBT parse
  // throws, and the item is left UNKNOWN with a zero cost basis — which is what
  // was inflating "expected net profit". Normalise to the bare string first.
  const itemBytes =
    typeof auction.item_bytes === 'string'
      ? auction.item_bytes
      : auction.item_bytes?.data ?? null;

  // The SkyBlock item id lives in the NBT, not on the auction envelope.
  let itemId = null;
  if (itemBytes) {
    try {
      itemId = (await readExtraAttributes(itemBytes))?.id ?? null;
    } catch {
      /* corrupt NBT — fall through unidentified */
    }
  }

  const row = {
    auction_id: auction.uuid,
    item_id: itemId ?? 'UNKNOWN',
    // Without an id there is no recipe to cost against, so skip the NBT work too.
    item_bytes: itemId ? itemBytes : null,
    crafted_at: null,
    sold_at: end, // projected sale time (or the actual one, for a sold listing)
    price: expectedSale,
    bin: bin ? 1 : 0,
    seller: auction.auctioneer,
  };

  const flip = await buildFlip(row, db);

  return {
    ...flip,
    itemName: itemId ? flip.itemName : auction.item_name ?? 'Unknown item',
    status,
    endsAt: iso(end),
    listPrice,
    expectedSale,
  };
}

/** Roll a set of priced pending listings into the box's headline totals. */
export function summarizePending(listings) {
  const willSell = listings.filter((l) => l.status !== 'expired');
  const sum = (sel) => willSell.reduce((n, l) => n + sel(l), 0);
  return {
    counts: {
      active: listings.filter((l) => l.status === 'active').length,
      sold: listings.filter((l) => l.status === 'sold').length,
      expired: listings.filter((l) => l.status === 'expired').length,
    },
    expectedNet: sum((l) => l.netProfit),
    expectedSaleValue: sum((l) => l.expectedSale),
    expectedFees: sum((l) => l.ahFees),
    expectedCost: sum((l) => l.costBasis),
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export function rangeStart(range, now = Date.now()) {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  return days === undefined ? 0 : now - days * 86400_000;
}

/**
 * When the seller's coins actually went into this item.
 *
 * For a craft that is the craft stamp. For a resell it is the purchase — the
 * item may have been crafted by a stranger months earlier, and measuring the
 * hold from that stamp describes someone else's holding, not theirs.
 */
const acquiredAt = (f) => Date.parse(f.purchase ? f.purchase.boughtAt : f.craftedAt);

export function summarize(flips) {
  const n = flips.length;
  const netProfit = flips.reduce((a, f) => a + f.netProfit, 0);
  const grossRevenue = flips.reduce((a, f) => a + f.salePrice, 0);

  // Hold time drives coins/hour. Flips with an estimated craft time have a
  // meaningless hold, so they are excluded from the denominator rather than
  // contributing a zero that inflates the rate to infinity. A recorded purchase
  // is an exact acquisition time, so those count even when the craft stamp was
  // guessed — the hold is measured from the buy, which we know.
  const holdHours = flips
    .filter((f) => f.purchase || !f.ageEstimated)
    .reduce((a, f) => a + (Date.parse(f.soldAt) - acquiredAt(f)) / 3600_000, 0);

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
