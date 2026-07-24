/**
 * The wire contract between this frontend and the backend described in
 * BACKEND.md. Everything here is plain JSON; all coin amounts are integers
 * (whole coins, never fractional), all timestamps are ISO-8601 UTC strings.
 */

export type Rarity =
  | 'COMMON'
  | 'UNCOMMON'
  | 'RARE'
  | 'EPIC'
  | 'LEGENDARY'
  | 'MYTHIC';

/**
 * How the backend priced this flip's ingredients.
 * - own_snapshot:  our own bazaar/AH archive covered the craft timestamp (best)
 * - coflnet:       backfilled from a third-party price history (good)
 * - live_fallback: no history existed, current price substituted (weak — the
 *                  UI must surface this so the number is not read as exact)
 */
export type PriceSource = 'own_snapshot' | 'coflnet' | 'live_fallback';

export type RangeKey = '7d' | '30d' | '90d' | 'all';

export interface Player {
  uuid: string;
  username: string;
}

export interface Ingredient {
  itemId: string;
  name: string;
  quantity: number;
  /** Price of one unit at the moment the item was crafted. */
  unitPrice: number;
  totalPrice: number;
  source: PriceSource;
}

export interface FeeLine {
  label: string;
  amount: number;
}

export type UpgradeKind =
  | 'enchantment'
  | 'reforge'
  | 'hot_potato'
  | 'recombobulator'
  | 'star'
  | 'gemstone'
  | 'rune'
  | 'scroll'
  | 'cosmetic'
  | 'misc';

/**
 * Something bought and applied to the item after crafting — an enchantment
 * book, a recombobulator, dungeon stars, gemstones. These are cost basis. A
 * tracker that prices only the recipe treats every one of them as pure profit.
 *
 * `totalPrice` is null when the upgrade could not be priced (auction-only items
 * with no history). That is reported, never silently treated as zero.
 */
export interface Upgrade {
  kind: UpgradeKind;
  label: string;
  quantity: number;
  unitPrice: number | null;
  totalPrice: number | null;
  source: PriceSource | null;
}

/** Canonical item metadata, from /v2/resources/skyblock/items. */
export interface ItemMetadata {
  itemId: string;
  name: string;
  tier: Rarity | null;
  category: string | null;
  npcSellPrice: number | null;
  /** Essence cost per dungeon star tier, straight from the official resource. */
  starCosts: { essenceType: string; amount: number }[][] | null;
  gemstoneSlots: number;
}

export interface FlipSummary {
  auctionUuid: string;
  itemId: string;
  itemName: string;
  rarity: Rarity;
  /** From NBT ExtraAttributes.timestamp. */
  craftedAt: string;
  soldAt: string;
  /** True when craftedAt was inferred from the auction rather than read from NBT. */
  ageEstimated: boolean;
  /**
   * How the seller got the base item. Craft-flipping and upgrade-flipping are
   * different businesses and price their base differently.
   */
  acquisition: 'crafted' | 'bought' | 'unknown';
  /**
   * What the base item cost before any upgrades: the recipe ingredient total if
   * crafted, or the cheapest CLEAN market listing if bought. Where both are
   * available a rational flipper takes the cheaper, so should this.
   */
  baseItemCost: number;
  /** Enchantments, reforges, stars, gems and the rest, priced at craft time. */
  upgradeCost: number;
  /** baseItemCost + upgradeCost — what the sold item actually cost to produce. */
  costBasis: number;
  /** Upgrades detected on the item that no price could be found for. */
  unpricedUpgrades: number;
  salePrice: number;
  ahFees: number;
  netProfit: number;
  /** netProfit / costBasis, as a percentage. */
  profitPct: number;
  priceSource: PriceSource;
  bin: boolean;
  /**
   * True when the operator has excluded this flip from every aggregate. The flip
   * still appears in the table (so it can be re-included); it just contributes
   * nothing to net profit, revenue, fees, by-item totals or the charts. Absent on
   * responses from an older backend, which is treated as "included".
   */
  excluded?: boolean;
}

export interface FlipDetail extends FlipSummary {
  /** Recipe breakdown; empty when the base item was bought rather than crafted. */
  ingredients: Ingredient[];
  upgrades: Upgrade[];
  metadata: ItemMetadata | null;
  fees: FeeLine[];
  listedAt: string;
  /** What the same craft would cost right now — null if unpriceable today. */
  currentCraftCost: number | null;
  /** Current lowest BIN / bazaar price for the crafted item. */
  currentMarketPrice: number | null;
}

export interface ProfitPoint {
  /** YYYY-MM-DD */
  date: string;
  /** Net profit realised on this day. */
  daily: number;
  /** Running total from the start of the range. */
  cumulative: number;
}

export interface ItemAggregate {
  itemId: string;
  itemName: string;
  flips: number;
  netProfit: number;
  avgMarginPct: number;
  revenue: number;
}

export interface DashboardStats {
  netProfit: number;
  grossRevenue: number;
  totalBaseItemCost: number;
  totalUpgradeCost: number;
  totalFees: number;
  flipCount: number;
  /** Share of flips with netProfit > 0, as a percentage. */
  winRatePct: number;
  avgMarginPct: number;
  /** Net profit divided by total craft→sale hold time, in coins per hour. */
  coinsPerHour: number;
  bestFlip: FlipSummary | null;
  /** Share of flips priced from our own snapshots, as a percentage. */
  confidencePct: number;
}

export interface DashboardResponse {
  player: Player;
  range: RangeKey;
  stats: DashboardStats;
  profitSeries: ProfitPoint[];
  byItem: ItemAggregate[];
  recentFlips: FlipSummary[];
}

/**
 * A page of a player's flips. The dashboard shows only a preview; this is how
 * the full history is reached. Without it the UI silently hides most of what a
 * player sold, which is worse than showing nothing.
 */
export interface FlipsPage {
  player: Player;
  flips: FlipSummary[];
  page: number;
  pageSize: number;
  totalFlips: number;
  totalPages: number;
}

/**
 * A player's currently-unclaimed auctions, priced for expected profit. The
 * status splits the three things "unclaimed" can mean:
 *   active   still listed, no buyer yet — will sell if a buyer comes
 *   sold     ended with a buyer, coins waiting to be claimed
 *   expired  ended with no buyer — the item returns, no sale happens
 */
export type ListingStatus = 'active' | 'sold' | 'expired';

export interface PendingListing extends FlipSummary {
  status: ListingStatus;
  /** When the auction ends (active) or ended (sold/expired). ISO. */
  endsAt: string;
  /** Starting bid / BIN price the item was listed at. */
  listPrice: number;
  /** Projected sale price the profit estimate is built on. */
  expectedSale: number;
}

export interface PendingResponse {
  player: Player;
  generatedAt: string;
  listings: PendingListing[];
  totals: {
    counts: { active: number; sold: number; expired: number };
    /** Net profit if every active + sold listing settles — the headline. */
    expectedNet: number;
    expectedSaleValue: number;
    expectedFees: number;
    expectedCost: number;
  };
}

export interface ItemHistoryPoint {
  date: string;
  craftCost: number;
  marketPrice: number;
}

export interface ItemHistoryResponse {
  itemId: string;
  itemName: string;
  rarity: Rarity;
  points: ItemHistoryPoint[];
  /** Flips of this item by the player currently in context. */
  flips: FlipSummary[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
