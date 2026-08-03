/**
 * Deterministic fake data so the UI can be developed and demoed before the
 * backend exists. Shapes here are the contract in types.ts — when the real API
 * lands, flip VITE_USE_MOCKS to false and nothing else changes.
 */

import type {
  CraftComponent,
  CraftListing,
  CraftNode,
  CraftPlan,
  CraftVariant,
  DashboardResponse,
  DashboardStats,
  FlipDetail,
  FlipSummary,
  Ingredient,
  ItemAggregate,
  FlipsPage,
  ItemHistoryResponse,
  ListingStatus,
  PendingListing,
  PendingResponse,
  PriceSource,
  ProfitPoint,
  Rarity,
  RangeKey,
  SalesResponse,
  Upgrade,
} from './types';
import { ApiError } from './types';

/* ---------- seeded RNG (mulberry32) so every reload looks identical ---------- */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- catalogue ---------- */

interface UpgradeDef {
  kind: Upgrade['kind'];
  label: string;
  quantity: number;
  unit: number | null;
}

interface RecipeDef {
  itemId: string;
  itemName: string;
  rarity: Rarity;
  sale: number;
  ingredients: { itemId: string; name: string; quantity: number; unit: number }[];
  /** Upgrades typically applied before this item is resold. */
  upgrades?: UpgradeDef[];
}

const RECIPES: RecipeDef[] = [
  {
    itemId: 'GEMSTONE_GAUNTLET',
    itemName: 'Gemstone Gauntlet',
    rarity: 'MYTHIC',
    sale: 58_400_000,
    ingredients: [
      { itemId: 'PERFECT_RUBY_GEM', name: 'Perfect Ruby Gemstone', quantity: 1, unit: 14_600_000 },
      { itemId: 'PERFECT_AMETHYST_GEM', name: 'Perfect Amethyst Gemstone', quantity: 1, unit: 13_900_000 },
      { itemId: 'PERFECT_SAPPHIRE_GEM', name: 'Perfect Sapphire Gemstone', quantity: 1, unit: 12_100_000 },
      { itemId: 'REFINED_MITHRIL', name: 'Refined Mithril', quantity: 8, unit: 420_000 },
    ],
    // Bazaar prices below are real values observed on 2026-07-20.
    upgrades: [
      { kind: 'gemstone', label: 'Flawless Aquamarine Gemstone', quantity: 2, unit: 1_914_672 },
      { kind: 'reforge', label: 'Fabled reforge', quantity: 1, unit: null },
    ],
  },
  {
    itemId: 'DAEDALUS_AXE',
    itemName: 'Daedalus Axe',
    rarity: 'LEGENDARY',
    sale: 22_100_000,
    ingredients: [
      { itemId: 'PERFECT_JADE_GEM', name: 'Perfect Jade Gemstone', quantity: 1, unit: 13_400_000 },
      { itemId: 'GOLDEN_TOOTH', name: 'Golden Tooth', quantity: 4, unit: 1_180_000 },
      { itemId: 'ENCHANTED_GOLD_BLOCK', name: 'Enchanted Gold Block', quantity: 16, unit: 62_000 },
    ],
    upgrades: [{ kind: 'enchantment', label: 'Sharpness VI', quantity: 1, unit: 885_995 }],
  },
  {
    itemId: 'SUPERIOR_CHESTPLATE',
    itemName: 'Superior Dragon Chestplate',
    rarity: 'LEGENDARY',
    sale: 14_250_000,
    ingredients: [
      { itemId: 'SUPERIOR_FRAGMENT', name: 'Superior Dragon Fragment', quantity: 40, unit: 268_000 },
      { itemId: 'ENCHANTED_DIAMOND_BLOCK', name: 'Enchanted Diamond Block', quantity: 4, unit: 512_000 },
    ],
    upgrades: [
      { kind: 'hot_potato', label: 'Hot Potato Book', quantity: 5, unit: 89_990 },
      { kind: 'reforge', label: 'Ancient reforge', quantity: 1, unit: null },
    ],
  },
  {
    itemId: 'TITANIC_EXP_BOTTLE',
    itemName: 'Titanic Experience Bottle',
    rarity: 'EPIC',
    sale: 2_640_000,
    ingredients: [
      { itemId: 'GRAND_EXP_BOTTLE', name: 'Grand Experience Bottle', quantity: 8, unit: 268_000 },
      { itemId: 'ENCHANTED_GLASS', name: 'Enchanted Glass', quantity: 32, unit: 9_400 },
    ],
  },
  {
    itemId: 'BEACON_4',
    itemName: 'Beacon IV',
    rarity: 'RARE',
    sale: 5_420_000,
    ingredients: [
      { itemId: 'BEACON_3', name: 'Beacon III', quantity: 1, unit: 2_700_000 },
      { itemId: 'ENCHANTED_OBSIDIAN', name: 'Enchanted Obsidian', quantity: 64, unit: 27_800 },
    ],
  },
  {
    itemId: 'ENCHANTED_DIAMOND_BLOCK',
    itemName: 'Enchanted Diamond Block',
    rarity: 'COMMON',
    sale: 1_048_000,
    ingredients: [
      { itemId: 'ENCHANTED_DIAMOND', name: 'Enchanted Diamond', quantity: 160, unit: 6_180 },
    ],
  },
  {
    itemId: 'REFINED_TITANIUM',
    itemName: 'Refined Titanium',
    rarity: 'UNCOMMON',
    sale: 486_000,
    ingredients: [
      { itemId: 'TITANIUM_ORE', name: 'Titanium', quantity: 4, unit: 106_000 },
    ],
  },
];

/* ---------- AH fee model (mirrors the backend's versioned fee table) ---------- */

/**
 * Claim tax is a flat 1%; it is the LISTING fee that is tiered — 1% under 10M,
 * 2% to 100M, 2.5% above. Keep in step with computeFees in api/src/flips.js.
 */
export function ahFees(salePrice: number, bin: boolean): { fees: { label: string; amount: number }[]; total: number } {
  let listingRate = 0.01;
  if (salePrice >= 100_000_000) listingRate = 0.025;
  else if (salePrice >= 10_000_000) listingRate = 0.02;

  const claiming = Math.round(salePrice * 0.01);
  const listing = Math.round(salePrice * listingRate);
  const fees = [
    { label: 'Claiming tax (1.0%)', amount: claiming },
    {
      // Charged on the listed price; for non-BIN we only know the hammer price.
      label: `Listing fee (${(listingRate * 100).toFixed(1)}%)${bin ? '' : ', estimated on sale price'}`,
      amount: listing,
    },
  ];
  return { fees, total: claiming + listing };
}

/* ---------- flip pool ---------- */

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0); // fixed clock keeps mocks stable
const DAY = 86_400_000;

const SOURCES: PriceSource[] = ['own_snapshot', 'own_snapshot', 'own_snapshot', 'coflnet', 'live_fallback'];

function buildPool(): FlipDetail[] {
  const rand = rng(20260720);
  const pool: FlipDetail[] = [];

  for (let i = 0; i < 78; i++) {
    const recipe = RECIPES[Math.floor(rand() * RECIPES.length)];
    const craftedAtMs = NOW - Math.floor(rand() * 90 * DAY) - DAY;
    const holdMs = Math.round((0.5 + rand() * 90) * 3_600_000);
    const soldAtMs = Math.min(craftedAtMs + holdMs, NOW - 3_600_000);
    const listedAtMs = craftedAtMs + Math.round(holdMs * 0.15);

    // Ingredient prices drift ±12%; sale price drifts ±9%. Their independence
    // is what produces the occasional losing flip.
    const costDrift = 0.88 + rand() * 0.24;
    const saleDrift = 0.91 + rand() * 0.18;

    const ingredients: Ingredient[] = recipe.ingredients.map((ing) => {
      const unitPrice = Math.round(ing.unit * costDrift * (0.97 + rand() * 0.06));
      return {
        itemId: ing.itemId,
        name: ing.name,
        quantity: ing.quantity,
        unitPrice,
        totalPrice: unitPrice * ing.quantity,
        source: SOURCES[Math.floor(rand() * SOURCES.length)],
      };
    });

    // Demo data models craft-flips, so the base item cost is the recipe total.
    // For an upgrade-flip this slot would instead hold the cheapest clean
    // market listing of the base item — see BACKEND.md §7.1.
    const baseItemCost = ingredients.reduce((s, x) => s + x.totalPrice, 0);

    // Upgrades applied after crafting. Priced at craft time like ingredients;
    // a null unit price means the upgrade exists but could not be valued.
    const upgrades: Upgrade[] = (recipe.upgrades ?? []).map((u) => {
      if (u.unit === null) {
        return { ...u, unitPrice: null, totalPrice: null, source: null };
      }
      const unitPrice = Math.round(u.unit * costDrift * (0.97 + rand() * 0.06));
      return {
        ...u,
        unitPrice,
        totalPrice: unitPrice * u.quantity,
        source: SOURCES[Math.floor(rand() * SOURCES.length)],
      };
    });

    /**
     * Roughly one flip in six is a RESELL rather than a craft: the same
     * physical item bought at auction and relisted, matched by its NBT uuid.
     *
     * Its cost basis is the price paid — this player never ran the recipe — so
     * it carries no ingredients and no upgrades, and the table renders its
     * profit blue instead of green/red.
     */
    const purchase =
      rand() < 0.17
        ? {
            auctionUuid: `mock-buy-${i.toString().padStart(4, '0')}`,
            // Bought under what crafting one costs, which is the entire reason
            // to buy rather than craft.
            price: Math.round(baseItemCost * (0.72 + rand() * 0.2)),
            boughtAt: new Date(craftedAtMs + Math.round(holdMs * 0.4)).toISOString(),
          }
        : null;

    const upgradeCost = purchase ? 0 : upgrades.reduce((s, u) => s + (u.totalPrice ?? 0), 0);
    const unpricedUpgrades = purchase ? 0 : upgrades.filter((u) => u.totalPrice === null).length;
    const costBasis = (purchase ? purchase.price : baseItemCost) + upgradeCost;

    const bin = rand() > 0.28;
    const salePrice = Math.round(recipe.sale * saleDrift);
    const { fees, total: feeTotal } = ahFees(salePrice, bin);
    const netProfit = salePrice - feeTotal - costBasis;

    // Worst source across ingredients decides the flip's overall confidence.
    const priceSource: PriceSource = ingredients.some((x) => x.source === 'live_fallback')
      ? 'live_fallback'
      : ingredients.some((x) => x.source === 'coflnet')
        ? 'coflnet'
        : 'own_snapshot';

    pool.push({
      auctionUuid: `mock-${i.toString().padStart(4, '0')}-${recipe.itemId.toLowerCase()}`,
      itemId: recipe.itemId,
      itemName: recipe.itemName,
      rarity: recipe.rarity,
      craftedAt: new Date(craftedAtMs).toISOString(),
      listedAt: new Date(listedAtMs).toISOString(),
      soldAt: new Date(soldAtMs).toISOString(),
      ageEstimated: rand() < 0.12,
      acquisition: purchase ? 'bought' : 'crafted',
      baseItemCost: purchase ? purchase.price : baseItemCost,
      upgradeCost,
      costBasis,
      unpricedUpgrades,
      salePrice,
      ahFees: feeTotal,
      netProfit,
      profitPct: (netProfit / costBasis) * 100,
      // A recorded purchase price is exact — nothing about it was inferred.
      priceSource: purchase ? 'own_snapshot' : priceSource,
      bin,
      purchase,
      ingredients: purchase ? [] : ingredients,
      upgrades: purchase ? [] : upgrades,
      metadata: {
        itemId: recipe.itemId,
        name: recipe.itemName,
        tier: recipe.rarity,
        category: null,
        npcSellPrice: null,
        starCosts: null,
        gemstoneSlots: recipe.upgrades?.filter((u) => u.kind === 'gemstone').length ?? 0,
      },
      fees,
      currentCraftCost: Math.round(baseItemCost * (0.94 + rand() * 0.16)),
      currentMarketPrice: Math.round(recipe.sale * (0.95 + rand() * 0.12)),
    });
  }

  return pool.sort((a, b) => +new Date(b.soldAt) - +new Date(a.soldAt));
}

const POOL = buildPool();

const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90, all: 3650 };

/**
 * Flips the user has excluded in mock mode. Lives here (not localStorage) so it
 * resets on reload like the rest of the deterministic demo data, while still
 * proving the exclude toggle end-to-end without a backend.
 */
const mockExclusions = new Set<string>();

export function setMockExclusion(auctionUuid: string, excluded: boolean): void {
  if (excluded) mockExclusions.add(auctionUuid);
  else mockExclusions.delete(auctionUuid);
}

/** A summary tagged with its current mock exclusion state. */
function withExclusion(f: FlipDetail): FlipSummary {
  return { ...strip(f), excluded: mockExclusions.has(f.auctionUuid) };
}

function strip(f: FlipDetail): FlipSummary {
  const {
    ingredients: _i,
    upgrades: _u,
    metadata: _md,
    fees: _f,
    listedAt: _l,
    currentCraftCost: _c,
    currentMarketPrice: _m,
    ...rest
  } = f;
  return rest;
}

/* ---------- endpoints ---------- */

export function mockDashboard(username: string, range: RangeKey): DashboardResponse {
  const cutoff = NOW - RANGE_DAYS[range] * DAY;
  const inRange = POOL.filter((f) => +new Date(f.soldAt) >= cutoff);
  // Aggregates count only the included flips; the table below keeps the full set.
  const flips = inRange.filter((f) => !mockExclusions.has(f.auctionUuid));

  const netProfit = sum(flips, (f) => f.netProfit);
  const grossRevenue = sum(flips, (f) => f.salePrice);
  const totalBaseItemCost = sum(flips, (f) => f.baseItemCost);
  const totalUpgradeCost = sum(flips, (f) => f.upgradeCost);
  const totalFees = sum(flips, (f) => f.ahFees);
  const wins = flips.filter((f) => f.netProfit > 0).length;
  const holdHours = sum(flips, (f) => (+new Date(f.soldAt) - +new Date(f.craftedAt)) / 3_600_000);
  const archived = flips.filter((f) => f.priceSource === 'own_snapshot').length;

  const stats: DashboardStats = {
    netProfit,
    grossRevenue,
    totalBaseItemCost,
    totalUpgradeCost,
    totalFees,
    flipCount: flips.length,
    winRatePct: flips.length ? (wins / flips.length) * 100 : 0,
    avgMarginPct: flips.length ? sum(flips, (f) => f.profitPct) / flips.length : 0,
    coinsPerHour: holdHours > 0 ? netProfit / holdHours : 0,
    bestFlip: flips.length ? strip([...flips].sort((a, b) => b.netProfit - a.netProfit)[0]) : null,
    confidencePct: flips.length ? (archived / flips.length) * 100 : 0,
  };

  return {
    player: { uuid: '0d9b3f2c-5a4e-4d1b-9a7c-2e8f6b1d4c3a', username },
    range,
    stats,
    profitSeries: buildSeries(flips, cutoff),
    byItem: buildByItem(flips),
    recentFlips: inRange.slice(0, 500).map(withExclusion),
  };
}

export function mockFlips(
  username: string,
  range: RangeKey,
  page: number,
  pageSize: number,
): FlipsPage {
  const cutoff = NOW - RANGE_DAYS[range] * DAY;
  const flips = POOL.filter((f) => +new Date(f.soldAt) >= cutoff);
  const start = page * pageSize;

  return {
    player: { uuid: '0d9b3f2c-5a4e-4d1b-9a7c-2e8f6b1d4c3a', username },
    flips: flips.slice(start, start + pageSize).map(withExclusion),
    page,
    pageSize,
    totalFlips: flips.length,
    totalPages: Math.max(1, Math.ceil(flips.length / pageSize)),
  };
}

export function mockFlipDetail(auctionUuid: string): FlipDetail {
  const found = POOL.find((f) => f.auctionUuid === auctionUuid);
  if (!found) throw new ApiError(`No flip with auction uuid ${auctionUuid}`, 404);
  return found;
}

export function mockItemHistory(itemId: string): ItemHistoryResponse {
  const recipe = RECIPES.find((r) => r.itemId === itemId);
  if (!recipe) throw new ApiError(`No item ${itemId}`, 404);

  const rand = rng(hash(itemId));
  const baseCost = recipe.ingredients.reduce((s, x) => s + x.unit * x.quantity, 0);
  const points = [];
  let cost = baseCost;
  let market = recipe.sale;

  for (let d = 89; d >= 0; d--) {
    cost *= 0.985 + rand() * 0.03;
    market *= 0.985 + rand() * 0.03;
    points.push({
      date: new Date(NOW - d * DAY).toISOString().slice(0, 10),
      craftCost: Math.round(cost),
      marketPrice: Math.round(market),
    });
  }

  return {
    itemId,
    itemName: recipe.itemName,
    rarity: recipe.rarity,
    points,
    // Every flip of this item, not a truncated sample — the page claims to show
    // "your flips of this item" and must not quietly drop some.
    flips: POOL.filter((f) => f.itemId === itemId).map(strip),
  };
}

export function mockPending(username: string): PendingResponse {
  // A few of the newest flips, re-cast as still-in-flight listings: most active
  // and ending soon, one already sold and waiting to be claimed, one expired.
  const sample = POOL.slice(0, 5);
  const states: ListingStatus[] = ['active', 'active', 'active', 'sold', 'expired'];

  const listings: PendingListing[] = sample.map((f, i) => {
    const status = states[i] ?? 'active';
    const endsAt =
      status === 'active'
        ? new Date(NOW + (i + 1) * 6 * 3_600_000).toISOString() // ends in the next hours
        : new Date(NOW - (i + 1) * 3_600_000).toISOString(); // ended recently
    return { ...strip(f), status, endsAt, listPrice: f.salePrice, expectedSale: f.salePrice };
  });

  const willSell = listings.filter((l) => l.status !== 'expired');
  const total = (sel: (l: PendingListing) => number) => sum(willSell, sel);

  return {
    player: { uuid: '0d9b3f2c-5a4e-4d1b-9a7c-2e8f6b1d4c3a', username },
    generatedAt: new Date(NOW).toISOString(),
    listings,
    totals: {
      counts: {
        active: listings.filter((l) => l.status === 'active').length,
        sold: listings.filter((l) => l.status === 'sold').length,
        expired: listings.filter((l) => l.status === 'expired').length,
      },
      expectedNet: total((l) => l.netProfit),
      expectedSaleValue: total((l) => l.expectedSale),
      expectedFees: total((l) => l.ahFees),
      expectedCost: total((l) => l.costBasis),
    },
  };
}

/* ---------- helpers ---------- */

function sum<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((s, x) => s + f(x), 0);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function buildSeries(flips: FlipDetail[], cutoff: number): ProfitPoint[] {
  const byDay = new Map<string, number>();
  for (const f of flips) {
    const key = f.soldAt.slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + f.netProfit);
  }

  const days = Math.ceil((NOW - cutoff) / DAY);
  const out: ProfitPoint[] = [];
  let running = 0;

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(NOW - i * DAY).toISOString().slice(0, 10);
    const daily = byDay.get(date) ?? 0;
    running += daily;
    out.push({ date, daily, cumulative: running });
  }
  return out;
}

function buildByItem(flips: FlipDetail[]): ItemAggregate[] {
  const map = new Map<string, ItemAggregate>();
  for (const f of flips) {
    const cur = map.get(f.itemId) ?? {
      itemId: f.itemId,
      itemName: f.itemName,
      flips: 0,
      netProfit: 0,
      avgMarginPct: 0,
      revenue: 0,
    };
    cur.flips += 1;
    cur.netProfit += f.netProfit;
    cur.revenue += f.salePrice;
    cur.avgMarginPct += f.profitPct;
    map.set(f.itemId, cur);
  }
  return [...map.values()]
    .map((a) => ({ ...a, avgMarginPct: a.avgMarginPct / a.flips }))
    .sort((a, b) => b.netProfit - a.netProfit);
}

/* -------------------------------------------------------------------- */
/* Craft planner                                                         */
/* -------------------------------------------------------------------- */

/**
 * A fixed Etherwarp Aspect of the Void build. Unlike the other mocks this one
 * is not randomised: the page's whole point is a live price, so demo mode
 * should show a plausible, stable shape and let the "Demo data" pill in the
 * header do the disclosing rather than inventing a different number per load.
 */
const MOCK_NULL_OVOID = 150_000;
const MOCK_REFINED_TITANIUM = 741_000;

/**
 * A bazaar ingredient. `unitPrice` is the instant-buy price, and the buy-order
 * side sits a few percent under it — the spread is what the page's instant/order
 * switch is for, so a mock without one leaves that control looking inert.
 */
const leaf = (itemId: string, name: string, quantity: number, unitPrice: number, spread = 0.94): CraftNode => ({
  itemId,
  name,
  quantity,
  unitPrice,
  totalPrice: Math.round(unitPrice * quantity),
  via: 'bazaar',
  bazaar: { instant: unitPrice, order: Math.round(unitPrice * spread) },
  children: [],
});

/** A short synthetic order book, so the listings box has something to render. */
function mockListings(floor: number, count: number, step: number): CraftListing[] {
  return Array.from({ length: count }, (_, i) => ({
    auctionId: `mock-${floor}-${i}`,
    price: floor + step * (i + 1),
    endsAt: new Date(NOW + (i + 1) * 37 * 60_000).toISOString(),
    clean: true,
  }));
}

export function mockCraftPlan(itemId: string, variant: CraftVariant): CraftPlan {
  const aoteChildren = [
    leaf('ENCHANTED_EYE_OF_ENDER', 'Enchanted Eye of Ender', 32, 9_447),
    leaf('ENCHANTED_DIAMOND', 'Enchanted Diamond', 1, 1_301),
  ];
  const aoteCost = aoteChildren.reduce((n, c) => n + (c.totalPrice ?? 0), 0);

  const baseChildren = [
    leaf('NULL_OVOID', 'Null Ovoid', 32, MOCK_NULL_OVOID),
    {
      itemId: 'ASPECT_OF_THE_END',
      name: 'Aspect of the End',
      quantity: 1,
      unitPrice: aoteCost,
      totalPrice: aoteCost,
      via: 'craft' as const,
      craftCost: aoteCost,
      marketPrice: 450_000,
      children: aoteChildren,
    },
  ];
  const baseCost = baseChildren.reduce((n, c) => n + (c.totalPrice ?? 0), 0);

  const conduitChildren = [
    leaf('NULL_OVOID', 'Null Ovoid', 24, MOCK_NULL_OVOID),
    leaf('REFINED_TITANIUM', 'Refined Titanium', 16, MOCK_REFINED_TITANIUM),
  ];
  const conduitCost = conduitChildren.reduce((n, c) => n + (c.totalPrice ?? 0), 0);

  const base: CraftComponent = {
    key: 'base',
    itemId: 'ASPECT_OF_THE_VOID',
    name: 'Aspect of the Void',
    quantity: 1,
    requires: null,
    craftCost: baseCost,
    marketPrice: 5_999_999,
    marketListings: 190,
    chosen: 'craft',
    cost: baseCost,
    nextCheapest: mockListings(5_999_999, 10, 130_000),
    unpriced: [],
    tree: {
      itemId: 'ASPECT_OF_THE_VOID',
      name: 'Aspect of the Void',
      quantity: 1,
      unitPrice: baseCost,
      totalPrice: baseCost,
      via: 'craft',
      craftCost: baseCost,
      marketPrice: 5_999_999,
      children: baseChildren,
    },
  };

  const conduit: CraftComponent = {
    key: 'conduit',
    itemId: 'ETHERWARP_CONDUIT',
    name: 'Etherwarp Conduit',
    quantity: 1,
    requires: 'Enderman Slayer 7',
    craftCost: conduitCost,
    marketPrice: 17_820_448,
    marketListings: 21,
    chosen: 'craft',
    cost: conduitCost,
    nextCheapest: mockListings(17_820_448, 10, 240_000),
    unpriced: [],
    tree: {
      itemId: 'ETHERWARP_CONDUIT',
      name: 'Etherwarp Conduit',
      quantity: 1,
      unitPrice: conduitCost,
      totalPrice: conduitCost,
      via: 'craft',
      craftCost: conduitCost,
      marketPrice: 17_820_448,
      children: conduitChildren,
    },
  };

  // No recipe exists for the Merger — it is an auction-only purchase, and the
  // reason craftOnly below is null.
  const merger: CraftComponent = {
    key: 'merger',
    itemId: 'ETHERWARP_MERGER',
    name: 'Etherwarp Merger',
    quantity: 1,
    requires: null,
    craftCost: null,
    marketPrice: 450_000,
    marketListings: 47,
    chosen: 'buy',
    cost: 450_000,
    nextCheapest: mockListings(450_000, 10, 21_000),
    unpriced: [],
    tree: {
      itemId: 'ETHERWARP_MERGER',
      name: 'Etherwarp Merger',
      quantity: 1,
      unitPrice: 450_000,
      totalPrice: 450_000,
      via: 'auction',
      craftCost: null,
      marketPrice: 450_000,
      children: [],
    },
  };

  const components = variant === 'etherwarp' ? [base, conduit, merger] : [base];
  const total = components.reduce((n, c) => n + (c.cost ?? 0), 0);
  const lowestBin = variant === 'etherwarp' ? 25_000_000 : 5_999_999;
  const now = new Date(NOW).toISOString();

  return {
    itemId,
    itemName: 'Aspect of the Void',
    rarity: 'EPIC',
    variant,
    variantLabel: variant === 'etherwarp' ? 'Etherwarp' : 'Clean',
    description:
      variant === 'etherwarp'
        ? 'Aspect of the Void with Etherwarp — the sword, a Conduit, and the Merger that fuses them.'
        : 'A bare Aspect of the Void, straight off the crafting grid.',
    generatedAt: now,
    components,
    total,
    craftOnly: variant === 'etherwarp' ? null : baseCost,
    unpriced: [],
    market: {
      lowestBin,
      comparableListings: variant === 'etherwarp' ? 88 : 29,
      cleanLowestBin: 5_999_999,
      cleanListings: 29,
      listings: 190,
      savingsVsBuying: lowestBin - total,
    },
    freshness: {
      bazaarAt: now,
      bazaarAgeSeconds: 3,
      auctionAt: now,
      auctionAgeSeconds: 8,
      auctionsScanned: 50_434,
      auctionPages: 51,
    },
  };
}

/* -------------------------------------------------------------------- */
/* Sales volume by upgrade set                                           */
/* -------------------------------------------------------------------- */

/**
 * Mirrors the real shape and the real ratio: the bare etherwarped sword is the
 * bulk of the volume and the fully built one is a thin fraction of it (measured
 * 112 against 836). A mock with two comparable series would make the built
 * cohort look like a liquid market it is not.
 */
export function mockSalesVolume(itemId: string, days: number): SalesResponse {
  const rand = rng(hash(`sales-${itemId}`));
  const hours = days * 24;
  const HOUR = DAY / 24;
  const current = Math.floor(NOW / HOUR) * HOUR;
  const stamps = Array.from(
    { length: hours },
    (_, i) => `${new Date(current - (hours - 1 - i) * HOUR).toISOString().slice(0, 13)}:00:00Z`,
  );

  // Diurnal: the server is busiest around 18:00 UTC and near-dead at 07:00, so
  // a flat random series would hide the shape the hourly view exists to show.
  const etherwarp = stamps.map((hour, i) => {
    const h = Number(hour.slice(11, 13));
    const wave = 0.35 + 0.65 * Math.max(0, Math.sin(((h - 3) / 24) * Math.PI * 2) * 0.5 + 0.5);
    const sales = Math.round((2 + rand() * 5) * wave * (i === hours - 1 ? 0.4 : 1));
    return {
      hour,
      sales,
      medianPrice: sales ? 25_000_000 + Math.round(rand() * 3_000_000) : null,
      partial: i === hours - 1,
    };
  });

  const built = stamps.map((hour, i) => {
    const sales = rand() < 0.55 ? 0 : 1 + Math.round(rand() * (i === hours - 1 ? 0 : 1));
    return {
      hour,
      sales,
      medianPrice: sales ? 29_500_000 + Math.round(rand() * 2_000_000) : null,
      partial: i === hours - 1,
    };
  });

  return {
    itemId,
    itemName: 'Aspect of the Void',
    days,
    hours,
    generatedAt: new Date(NOW).toISOString(),
    cohorts: [
      {
        key: 'ethermerge',
        label: 'Etherwarp only',
        match: 'exact' as const,
        upgrades: ['ethermerge'],
        enchants: [],
        sales: etherwarp.reduce((n, p) => n + p.sales, 0),
        medianPrice: 26_600_000,
        points: etherwarp,
      },
      {
        key: 'ethermerge_built',
        label: 'Etherwarp + tuner + gems + Wise V',
        match: 'contains' as const,
        upgrades: ['ethermerge', 'tuned_transmission', 'gems'],
        enchants: [{ type: 'ultimate_wise', level: 5 }],
        sales: built.reduce((n, p) => n + p.sales, 0),
        medianPrice: 29_999_000,
        points: built,
      },
    ],
    coverage: {
      salesScanned: 3121,
      pagesFetched: 4,
      truncated: false,
      from: new Date(NOW - days * DAY).toISOString(),
      to: new Date(NOW).toISOString(),
    },
    topShapes: [
      { upgrades: '(clean)', sales: 1059 },
      { upgrades: 'ethermerge', sales: 754 },
      { upgrades: 'enchantments', sales: 201 },
      { upgrades: 'enchantments+tuned_transmission', sales: 166 },
      { upgrades: 'enchantments+ethermerge+gems+tuned_transmission', sales: 139 },
      { upgrades: 'ethermerge+tuned_transmission', sales: 117 },
    ],
    unclassifiedKeys: [],
    attribution: 'Sales data from Coflnet — sky.coflnet.com',
    cachedAgeSeconds: 0,
  };
}
