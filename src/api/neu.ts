/**
 * Crafting recipes from the NotEnoughUpdates item repo.
 *
 * The Hypixel API has no recipes — a live check found 1 item out of 5,524 with a
 * recipe field — so this is where craft costs come from. Files are served per
 * item from raw.githubusercontent, which sends permissive CORS headers.
 *
 * A backend should clone the repo and read it from disk (BACKEND.md §5) rather
 * than fetching per item; this per-item path exists because the browser has no
 * filesystem.
 */

const REPO =
  'https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items';

export interface NeuItem {
  itemid?: string;
  displayname?: string;
  /** 3×3 grid, slots A1..C3, values "ITEM_ID:count". `count` = output quantity. */
  recipe?: Record<string, string | number>;
  /**
   * May hold either grid recipes or forge ones. A forge entry has
   * `type: "forge"` and a flat `inputs: ["ITEM_ID:qty", …]` instead of slots.
   */
  recipes?: Record<string, string | number | string[]>[];
}

const cache = new Map<string, NeuItem | null>();
const inflight = new Map<string, Promise<NeuItem | null>>();

export async function fetchNeuItem(itemId: string): Promise<NeuItem | null> {
  if (cache.has(itemId)) return cache.get(itemId)!;
  const pending = inflight.get(itemId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const r = await fetch(`${REPO}/${encodeURIComponent(itemId)}.json`);
      const v = r.ok ? ((await r.json()) as NeuItem) : null;
      cache.set(itemId, v);
      return v;
    } catch {
      cache.set(itemId, null);
      return null;
    } finally {
      inflight.delete(itemId);
    }
  })();

  inflight.set(itemId, p);
  return p;
}

export interface ParsedRecipe {
  /** Ingredient id → total quantity across all grid slots. */
  ingredients: Map<string, number>;
  /** How many items one craft yields. */
  outputCount: number;
}

/** Grid slot keys are A1..C3; everything else on the object is metadata. */
const RECIPE_META = new Set(['count', 'type', 'overrideOutputId', 'duration']);

type RecipeGrid = Record<string, string | number | string[]>;

function parseOne(grid: RecipeGrid | undefined): ParsedRecipe | null {
  if (!grid || typeof grid !== 'object') return null;

  const ingredients = new Map<string, number>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    // "ENCHANTED_DIAMOND:32" — ids can carry a ";variant" suffix, and forge
    // quantities arrive as floats ("REFINED_MINERAL:32.0").
    const [idPart, qtyPart] = raw.split(':');
    const id = idPart.split(';')[0];
    if (!id) return;
    // The same ingredient occupies several slots; each slot contributes.
    ingredients.set(id, (ingredients.get(id) ?? 0) + (Number(qtyPart) || 1));
  };

  const inputs = (grid as { inputs?: unknown }).inputs;
  if (Array.isArray(inputs)) {
    // Forge recipe: a flat inputs array rather than a 3x3 grid. Divan's armour,
    // Gemstone Mixture and Powder Coating are forge-only, and treating them as
    // recipe-less prices the base at market instead of at what it cost to make.
    for (const raw of inputs) add(raw);
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
export function parseRecipe(item: NeuItem | null): ParsedRecipe | null {
  const candidates: RecipeGrid[] = [];
  if (item?.recipe) candidates.push(item.recipe as RecipeGrid);
  if (Array.isArray(item?.recipes)) candidates.push(...(item.recipes as RecipeGrid[]));

  for (const c of candidates) {
    const parsed = parseOne(c);
    if (parsed) return parsed;
  }
  return null;
}

export type CostSource = 'craft' | 'bazaar' | 'auction';

export interface CostBreakdown {
  itemId: string;
  /** Chosen unit cost, or null if nothing could price it. */
  price: number | null;
  source: CostSource | null;
  /** Cost to craft one, when a fully-priceable recipe exists. */
  craftCost: number | null;
  /** Cheapest way to buy one (bazaar instant-buy, or clean lowest BIN). */
  marketPrice: number | null;
  parts: { itemId: string; quantity: number; unitPrice: number | null }[];
}

export interface CostContext {
  /** Bazaar instant-buy for a product, or null when not sold there. */
  bazaar: (itemId: string) => number | null;
  /** Cheapest CLEAN auction listing, or null. */
  auction?: (itemId: string) => number | null;
}

/**
 * Cost one unit of an item, preferring what it costs to CRAFT.
 *
 * Order: craft (if the whole recipe prices) → bazaar → clean auction BIN.
 * Crafting is preferred because that is what the tracked seller actually does —
 * pricing their base at someone else's asking price overstates their costs and
 * can flip a profitable flip to a loss.
 *
 * Bazaar is checked before recursing for ingredients, so commodity inputs stop
 * the recursion rather than expanding into raw materials forever.
 */
export async function costOf(
  itemId: string,
  ctx: CostContext,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<CostBreakdown> {
  const empty: CostBreakdown = {
    itemId,
    price: null,
    source: null,
    craftCost: null,
    marketPrice: null,
    parts: [],
  };

  const bazaarPrice = ctx.bazaar(itemId);
  const auctionPrice = ctx.auction?.(itemId) ?? null;
  const marketPrice = bazaarPrice ?? auctionPrice;

  // Cycle guard, and a depth cap so a pathological chain cannot hang the page.
  if (depth > 4 || seen.has(itemId)) {
    return { ...empty, price: marketPrice, source: bazaarPrice !== null ? 'bazaar' : auctionPrice !== null ? 'auction' : null, marketPrice };
  }

  // A commodity that trades on the bazaar is priced there; do not expand it.
  if (depth > 0 && bazaarPrice !== null) {
    return { ...empty, price: bazaarPrice, source: 'bazaar', marketPrice: bazaarPrice };
  }

  const recipe = parseRecipe(await fetchNeuItem(itemId));
  if (!recipe) {
    return {
      ...empty,
      price: marketPrice,
      source: bazaarPrice !== null ? 'bazaar' : auctionPrice !== null ? 'auction' : null,
      marketPrice,
    };
  }

  const nextSeen = new Set(seen).add(itemId);
  const parts: CostBreakdown['parts'] = [];
  let sum = 0;
  let complete = true;

  for (const [ing, qty] of recipe.ingredients) {
    const sub = await costOf(ing, ctx, depth + 1, nextSeen);
    parts.push({ itemId: ing, quantity: qty, unitPrice: sub.price });
    if (sub.price === null) complete = false;
    else sum += sub.price * qty;
  }

  const craftCost = complete ? sum / recipe.outputCount : null;
  const price = craftCost ?? marketPrice;

  return {
    itemId,
    price,
    source: craftCost !== null ? 'craft' : bazaarPrice !== null ? 'bazaar' : auctionPrice !== null ? 'auction' : null,
    craftCost,
    marketPrice,
    parts,
  };
}
