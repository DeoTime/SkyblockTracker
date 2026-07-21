/**
 * Turns an item's NBT ExtraAttributes into the list of purchased upgrades that
 * belong in its cost basis.
 *
 * Field names and product-id conventions here were derived by decoding 1,000
 * live auctions and cross-checking every id against a live bazaar snapshot, not
 * from memory. Anything whose id cannot be resolved against the bazaar is
 * reported as unpriced rather than silently dropped or guessed at — an upgrade
 * we cannot price must show up as a gap, because omitting it inflates profit.
 */

import type { NbtValue } from './nbt';

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

export interface DetectedUpgrade {
  kind: UpgradeKind;
  label: string;
  quantity: number;
  /** Bazaar/AH product id to price against; null when nothing sells this. */
  productId: string | null;
  note?: string;
}

export interface PricedUpgrade extends DetectedUpgrade {
  unitPrice: number | null;
  totalPrice: number | null;
  /** Where the price came from. `craft` means we costed its recipe instead of buying. */
  pricedFrom: 'bazaar' | 'auction' | 'craft' | null;
}

/**
 * Upgrade items that are NOT sold on the bazaar and must be priced from auction
 * lowest-BIN. Names are what appears in an auction's `item_name`, used to
 * pre-filter a sweep before decoding NBT to confirm the real item id.
 */
export const AUCTION_ONLY_UPGRADES: { id: string; name: string }[] = [
  { id: 'ETHERWARP_CONDUIT', name: 'Etherwarp Conduit' },
  { id: 'ETHERWARP_MERGER', name: 'Etherwarp Merger' },
];

export type PriceResolver = (
  productId: string,
) => { price: number; source: 'bazaar' | 'auction' | 'craft' } | null;

/** Item metadata from /v2/resources/skyblock/items, for star costs. */
export interface ItemMeta {
  id: string;
  name?: string;
  tier?: string;
  category?: string;
  upgrade_costs?: { type: string; essence_type?: string; item_id?: string; amount: number }[][];
  gemstone_slots?: { slot_type: string; costs?: unknown[] }[];
}

const num = (v: NbtValue | undefined): number | null =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;

const str = (v: NbtValue | undefined): string | null => (typeof v === 'string' ? v : null);

export function detectUpgrades(
  ea: Record<string, NbtValue>,
  meta?: ItemMeta,
): DetectedUpgrade[] {
  const out: DetectedUpgrade[] = [];

  // --- enchantments: { sharpness: 6, ultimate_wisdom: 5 } ---
  const ench = ea.enchantments;
  if (ench && typeof ench === 'object' && !Array.isArray(ench)) {
    for (const [name, lvlRaw] of Object.entries(ench as Record<string, NbtValue>)) {
      const level = num(lvlRaw);
      if (level === null) continue;
      out.push({
        kind: 'enchantment',
        label: `${prettify(name)} ${roman(level)}`,
        quantity: 1,
        productId: `ENCHANTMENT_${name.toUpperCase()}_${level}`,
      });
    }
  }

  // --- reforge ---
  const modifier = str(ea.modifier);
  if (modifier) {
    out.push({
      kind: 'reforge',
      label: `${prettify(modifier)} reforge`,
      quantity: 1,
      productId: null,
      note: 'Needs a reforge-stone lookup table; basic reforges cost only the anvil fee.',
    });
  }

  // --- hot potato books: first 10 are Hot, the rest Fuming ---
  const potatoes = num(ea.hot_potato_count) ?? 0;
  if (potatoes > 0) {
    const hot = Math.min(potatoes, 10);
    const fuming = Math.max(0, potatoes - 10);
    out.push({ kind: 'hot_potato', label: 'Hot Potato Book', quantity: hot, productId: 'HOT_POTATO_BOOK' });
    if (fuming > 0) {
      out.push({
        kind: 'hot_potato',
        label: 'Fuming Potato Book',
        quantity: fuming,
        productId: 'FUMING_POTATO_BOOK',
      });
    }
  }

  // --- recombobulator ---
  const recomb = num(ea.rarity_upgrades) ?? 0;
  if (recomb > 0) {
    out.push({
      kind: 'recombobulator',
      label: 'Recombobulator 3000',
      quantity: recomb,
      productId: 'RECOMBOBULATOR_3000',
    });
  }

  // --- dungeon stars: exact essence costs come from item metadata ---
  const stars = num(ea.upgrade_level) ?? num(ea.dungeon_item_level) ?? 0;
  if (stars > 0) {
    const tiers = meta?.upgrade_costs?.slice(0, stars) ?? [];
    if (tiers.length === 0) {
      out.push({
        kind: 'star',
        label: `${stars}★ upgrade`,
        quantity: stars,
        productId: null,
        note: 'No upgrade_costs in item metadata for this item.',
      });
    } else {
      const essence = new Map<string, number>();
      const items = new Map<string, number>();
      for (const tier of tiers) {
        for (const cost of tier) {
          if (cost.type === 'ESSENCE' && cost.essence_type) {
            const id = `ESSENCE_${cost.essence_type}`;
            essence.set(id, (essence.get(id) ?? 0) + cost.amount);
          } else if (cost.item_id) {
            items.set(cost.item_id, (items.get(cost.item_id) ?? 0) + cost.amount);
          }
        }
      }
      for (const [id, amount] of essence) {
        out.push({
          kind: 'star',
          label: `${prettify(id.replace('ESSENCE_', ''))} Essence (${stars}★)`,
          quantity: amount,
          productId: id,
        });
      }
      for (const [id, amount] of items) {
        out.push({ kind: 'star', label: `${prettify(id)} (${stars}★)`, quantity: amount, productId: id });
      }
    }
  }

  // --- gemstones: { AQUAMARINE_0: "FLAWLESS", unlocked_slots: [...] } ---
  const gems = ea.gems;
  if (gems && typeof gems === 'object' && !Array.isArray(gems)) {
    for (const [slot, valRaw] of Object.entries(gems as Record<string, NbtValue>)) {
      if (slot === 'unlocked_slots') continue;
      // Newer entries are { quality, uuid } objects; older ones a bare string.
      const quality =
        typeof valRaw === 'string'
          ? valRaw
          : str((valRaw as Record<string, NbtValue> | undefined)?.quality);
      if (!quality) continue;
      const type = slot.replace(/_\d+$/, '').replace(/_gem$/i, '');
      out.push({
        kind: 'gemstone',
        label: `${prettify(quality)} ${prettify(type)} Gemstone`,
        quantity: 1,
        productId: `${quality.toUpperCase()}_${type.toUpperCase()}_GEM`,
      });
    }
  }

  // --- runes: auction-only, confirmed absent from the bazaar ---
  const runes = ea.runes;
  if (runes && typeof runes === 'object' && !Array.isArray(runes)) {
    for (const [name, lvlRaw] of Object.entries(runes as Record<string, NbtValue>)) {
      out.push({
        kind: 'rune',
        label: `${prettify(name)} Rune ${roman(num(lvlRaw) ?? 1)}`,
        quantity: 1,
        productId: null,
        note: 'Runes are not sold on the bazaar — price from auction history.',
      });
    }
  }

  // --- scrolls and one-off consumables (bazaar ids verified) ---
  const counted: [string, string, string][] = [
    ['art_of_war_count', 'THE_ART_OF_WAR', 'The Art of War'],
    ['artOfPeaceApplied', 'THE_ART_OF_PEACE', 'The Art of Peace'],
    ['wood_singularity_count', 'WOOD_SINGULARITY', 'Wood Singularity'],
    ['mana_disintegrator_count', 'MANA_DISINTEGRATOR', 'Mana Disintegrator'],
  ];
  for (const [field, productId, label] of counted) {
    const n = num(ea[field]) ?? 0;
    if (n > 0) out.push({ kind: 'scroll', label, quantity: n, productId });
  }

  const abilityScrolls = ea.ability_scroll;
  if (Array.isArray(abilityScrolls)) {
    for (const s of abilityScrolls) {
      const id = typeof s === 'string' ? s : null;
      if (id) out.push({ kind: 'scroll', label: prettify(id), quantity: 1, productId: id });
    }
  }

  // --- cosmetics: real coin cost, auction-only ---
  const dye = str(ea.dye_item);
  if (dye) {
    out.push({ kind: 'cosmetic', label: prettify(dye), quantity: 1, productId: dye, note: 'Auction-only.' });
  }
  const skin = str(ea.skin);
  if (skin) {
    out.push({ kind: 'cosmetic', label: prettify(skin), quantity: 1, productId: skin, note: 'Auction-only.' });
  }

  // --- misc flags that cost coins ---
  // The NBT value is the tuning LEVEL, and one Transmission Tuner is consumed
  // per level — so level N costs N tuners, not one item called "level N".
  const tuning = num(ea.tuned_transmission) ?? 0;
  if (tuning > 0) {
    out.push({
      kind: 'misc',
      label: `Transmission Tuner (to level ${tuning})`,
      quantity: tuning,
      productId: 'TRANSMISSION_TUNER',
    });
  }
  // Etherwarp consumes TWO items, not one: the Conduit (the expensive part, ~18.6M
  // on the AH) and the Merger that applies it. Emitting only the Merger
  // understated an Aspect of the Void's cost basis by an order of magnitude.
  if ((num(ea.ethermerge) ?? 0) > 0) {
    out.push({ kind: 'misc', label: 'Etherwarp Conduit', quantity: 1, productId: 'ETHERWARP_CONDUIT' });
    out.push({ kind: 'misc', label: 'Etherwarp Merger', quantity: 1, productId: 'ETHERWARP_MERGER' });
  }

  return out;
}

/** Prices detected upgrades, trying the bazaar and then auction lowest-BIN. */
export function priceUpgrades(
  upgrades: DetectedUpgrade[],
  resolve: PriceResolver,
): { priced: PricedUpgrade[]; total: number; unpriced: number } {
  let total = 0;
  let unpriced = 0;

  const priced = upgrades.map((u) => {
    const hit = u.productId ? resolve(u.productId) : null;
    if (hit === null) {
      unpriced++;
      return { ...u, unitPrice: null, totalPrice: null, pricedFrom: null };
    }
    const totalPrice = hit.price * u.quantity;
    total += totalPrice;
    return { ...u, unitPrice: hit.price, totalPrice, pricedFrom: hit.source };
  });

  return { priced, total, unpriced };
}

/**
 * True when an item carries no purchased upgrades — a "clean" base item.
 *
 * This is the test that makes base-item pricing honest. Most listings of a
 * popular item are upgraded: only 20 of 155 live Aspect of the Void listings
 * were clean. Take the naive lowest BIN for an item id and you are pricing
 * someone else's enchants and gems into your base cost, in whichever direction
 * the cheapest listing happens to lie.
 */
export function isCleanBase(ea: Record<string, NbtValue>): boolean {
  return detectUpgrades(ea).length === 0;
}

function prettify(s: string): string {
  return s
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}
