import { gunzipSync } from 'node:zlib';
import * as nbt from 'prismarine-nbt';

/**
 * NBT decoding for ended auctions. Mirrors src/lib/nbt.ts and
 * src/lib/upgrades.ts in the frontend — keep them in step.
 */

/** Cost-bearing ExtraAttributes keys. Presence of any means "not a clean base". */
const UPGRADE_KEYS = [
  'enchantments',
  'modifier',
  'hot_potato_count',
  'rarity_upgrades',
  'upgrade_level',
  'dungeon_item_level',
  'gems',
  'runes',
  'art_of_war_count',
  'ethermerge',
  'tuned_transmission',
  'dye_item',
  'skin',
  'ability_scroll',
  'power_ability_scroll',
  'mana_disintegrator_count',
  'wood_singularity_count',
  'talisman_enrichment',
];

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
 * Craft time from ExtraAttributes.timestamp.
 *
 * This is a TAG_Long. prismarine-nbt hands it back as [high, low] signed 32-bit
 * halves — passing that array to new Date() yields a nonsense date silently, and
 * every historical price lookup would then be anchored to the wrong day. Legacy
 * items use a date string instead.
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

/** Decode an auction's item_bytes. Returns null when there is nothing usable. */
export async function decodeItem(itemBytes) {
  const buf = gunzipSync(Buffer.from(itemBytes, 'base64'));
  const { parsed } = await nbt.parse(buf);
  const raw = parsed?.value?.i?.value?.value?.[0]?.tag?.value?.ExtraAttributes;
  if (!raw) return null;

  const ea = simplify(raw);
  const applied = UPGRADE_KEYS.filter((k) => k in ea);

  return {
    itemId: typeof ea.id === 'string' ? ea.id : null,
    craftedAt: readTimestamp(ea),
    upgrades: applied,
    isClean: applied.length === 0,
  };
}
