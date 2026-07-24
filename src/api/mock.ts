/**
 * Deterministic fake data so the UI can be developed and demoed before the
 * backend exists. Shapes here are the contract in types.ts — when the real API
 * lands, flip VITE_USE_MOCKS to false and nothing else changes.
 */

import type {
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

    const upgradeCost = upgrades.reduce((s, u) => s + (u.totalPrice ?? 0), 0);
    const unpricedUpgrades = upgrades.filter((u) => u.totalPrice === null).length;
    const costBasis = baseItemCost + upgradeCost;

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
      acquisition: 'crafted',
      baseItemCost,
      upgradeCost,
      costBasis,
      unpricedUpgrades,
      salePrice,
      ahFees: feeTotal,
      netProfit,
      profitPct: (netProfit / costBasis) * 100,
      priceSource,
      bin,
      ingredients,
      upgrades,
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
