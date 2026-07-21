import { gunzipSync } from 'node:zlib';
import * as nbt from 'prismarine-nbt';

/**
 * NBT decoding and upgrade detection. This is the JS port of the frontend's
 * src/lib/nbt.ts + src/lib/upgrades.ts — keep the three in step.
 *
 * We re-decode raw item_bytes here rather than trusting the ingest's summary,
 * which is exactly why the ingest retains NBT for tracked sellers.
 */

function simplify(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(simplify);
  if (typeof v === 'object') {
    if ('type' in v && 'value' in v) return simplify(v.value);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

/**
 * TAG_Long timestamp. prismarine-nbt yields [high, low] 32-bit halves; passing
 * that array to new Date() silently produces a nonsense date, and this field
 * anchors every historical price lookup.
 */
export function readTimestamp(ea) {
  const t = ea?.timestamp;
  if (t === undefined || t === null) return null;
  if (typeof t === 'number') return t;
  if (typeof t === 'bigint') return Number(t);
  if (Array.isArray(t) && t.length === 2) {
    const ms = t[0] * 2 ** 32 + (t[1] >>> 0);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === 'string') {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

export async function readExtraAttributes(itemBytes) {
  const { parsed } = await nbt.parse(gunzipSync(Buffer.from(itemBytes, 'base64')));
  const raw = parsed?.value?.i?.value?.value?.[0]?.tag?.value?.ExtraAttributes;
  return raw ? simplify(raw) : null;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const roman = (n) => ROMAN[n] ?? String(n);
const pretty = (s) =>
  String(s)
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/** Upgrade items with no bazaar listing — priced from auction history. */
export const AUCTION_ONLY = ['ETHERWARP_CONDUIT', 'ETHERWARP_MERGER'];

/**
 * Every purchased upgrade on an item. Returns [{kind,label,quantity,productId}].
 * productId null means nothing sells it directly (reforge stones, runes).
 */
export function detectUpgrades(ea, meta) {
  const out = [];
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);

  const ench = ea.enchantments;
  if (ench && typeof ench === 'object' && !Array.isArray(ench)) {
    for (const [name, lvl] of Object.entries(ench)) {
      const level = num(lvl);
      if (level === null) continue;
      out.push({
        kind: 'enchantment',
        label: `${pretty(name)} ${roman(level)}`,
        quantity: 1,
        productId: `ENCHANTMENT_${name.toUpperCase()}_${level}`,
      });
    }
  }

  if (typeof ea.modifier === 'string') {
    out.push({
      kind: 'reforge',
      label: `${pretty(ea.modifier)} reforge`,
      quantity: 1,
      productId: null,
      note: 'Reforge stone lookup not implemented; basic reforges cost only the anvil fee.',
    });
  }

  const potatoes = num(ea.hot_potato_count) ?? 0;
  if (potatoes > 0) {
    out.push({ kind: 'hot_potato', label: 'Hot Potato Book', quantity: Math.min(potatoes, 10), productId: 'HOT_POTATO_BOOK' });
    if (potatoes > 10) {
      out.push({ kind: 'hot_potato', label: 'Fuming Potato Book', quantity: potatoes - 10, productId: 'FUMING_POTATO_BOOK' });
    }
  }

  if ((num(ea.rarity_upgrades) ?? 0) > 0) {
    out.push({ kind: 'recombobulator', label: 'Recombobulator 3000', quantity: 1, productId: 'RECOMBOBULATOR_3000' });
  }

  // Dungeon stars: exact essence amounts come from official item metadata.
  const stars = num(ea.upgrade_level) ?? num(ea.dungeon_item_level) ?? 0;
  if (stars > 0) {
    const tiers = meta?.upgrade_costs?.slice(0, stars) ?? [];
    if (tiers.length === 0) {
      out.push({ kind: 'star', label: `${stars}★ upgrade`, quantity: stars, productId: null, note: 'No upgrade_costs in metadata.' });
    } else {
      const essence = new Map();
      for (const tier of tiers) {
        for (const c of tier) {
          if (c.type === 'ESSENCE' && c.essence_type) {
            const id = `ESSENCE_${c.essence_type}`;
            essence.set(id, (essence.get(id) ?? 0) + c.amount);
          } else if (c.item_id) {
            essence.set(c.item_id, (essence.get(c.item_id) ?? 0) + c.amount);
          }
        }
      }
      for (const [id, amount] of essence) {
        out.push({ kind: 'star', label: `${pretty(id)} (${stars}★)`, quantity: amount, productId: id });
      }
    }
  }

  const gems = ea.gems;
  if (gems && typeof gems === 'object' && !Array.isArray(gems)) {
    for (const [slot, val] of Object.entries(gems)) {
      if (slot === 'unlocked_slots') continue;
      const quality = typeof val === 'string' ? val : val?.quality;
      if (!quality) continue;
      const type = slot.replace(/_\d+$/, '');
      out.push({
        kind: 'gemstone',
        label: `${pretty(quality)} ${pretty(type)} Gemstone`,
        quantity: 1,
        productId: `${String(quality).toUpperCase()}_${type.toUpperCase()}_GEM`,
      });
    }
  }

  const runes = ea.runes;
  if (runes && typeof runes === 'object' && !Array.isArray(runes)) {
    for (const [name, lvl] of Object.entries(runes)) {
      out.push({
        kind: 'rune',
        label: `${pretty(name)} Rune ${roman(num(lvl) ?? 1)}`,
        quantity: 1,
        productId: null,
        note: 'Runes are not sold on the bazaar.',
      });
    }
  }

  for (const [field, productId, label] of [
    ['art_of_war_count', 'THE_ART_OF_WAR', 'The Art of War'],
    ['wood_singularity_count', 'WOOD_SINGULARITY', 'Wood Singularity'],
    ['mana_disintegrator_count', 'MANA_DISINTEGRATOR', 'Mana Disintegrator'],
  ]) {
    const n = num(ea[field]) ?? 0;
    if (n > 0) out.push({ kind: 'scroll', label, quantity: n, productId });
  }

  if (Array.isArray(ea.ability_scroll)) {
    for (const s of ea.ability_scroll) {
      if (typeof s === 'string') out.push({ kind: 'scroll', label: pretty(s), quantity: 1, productId: s });
    }
  }

  // A level, not a count: reaching level N consumes N tuners.
  const tuning = num(ea.tuned_transmission) ?? 0;
  if (tuning > 0) {
    out.push({ kind: 'misc', label: `Transmission Tuner (to level ${tuning})`, quantity: tuning, productId: 'TRANSMISSION_TUNER' });
  }

  // Etherwarp consumes TWO items. Emitting only the Merger understates an
  // Aspect of the Void by ~17M, since the Conduit is the expensive half.
  if ((num(ea.ethermerge) ?? 0) > 0) {
    out.push({ kind: 'misc', label: 'Etherwarp Conduit', quantity: 1, productId: 'ETHERWARP_CONDUIT' });
    out.push({ kind: 'misc', label: 'Etherwarp Merger', quantity: 1, productId: 'ETHERWARP_MERGER' });
  }

  if (typeof ea.dye_item === 'string') {
    out.push({ kind: 'cosmetic', label: pretty(ea.dye_item), quantity: 1, productId: ea.dye_item, note: 'Auction-only.' });
  }
  if (typeof ea.skin === 'string') {
    out.push({ kind: 'cosmetic', label: pretty(ea.skin), quantity: 1, productId: ea.skin, note: 'Auction-only.' });
  }

  return out;
}

export const isCleanBase = (ea) => detectUpgrades(ea).length === 0;
