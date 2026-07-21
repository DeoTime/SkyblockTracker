/**
 * The players this instance tracks.
 *
 * UUIDs are resolved and pinned here rather than looked up at runtime: Mojang's
 * lookup is rate-limited and does not reliably allow browser CORS, and the UUID
 * is the stable identity anyway. Note `s_flow` canonicalises to `s_floW` — the
 * display name's casing is cosmetic, the UUID is what the Hypixel API matches on.
 *
 * Verified against Mojang on 2026-07-20.
 */

export interface TrackedPlayer {
  /** Canonical Mojang display name. */
  name: string;
  /** Undashed UUID — the form Hypixel returns in `auctioneer` and `seller`. */
  uuid: string;
}

export const TRACKED_PLAYERS: TrackedPlayer[] = [
  { name: 's_floW', uuid: '826bf8088bf9406a88b1bf2242f1d317' },
  { name: 'cloudyv2', uuid: 'b7e55bf27a754acc9f105cb5472a6997' },
];

export const TRACKED_UUIDS = new Set(TRACKED_PLAYERS.map((p) => p.uuid));

export function playerByUuid(uuid: string): TrackedPlayer | undefined {
  return TRACKED_PLAYERS.find((p) => p.uuid === uuid);
}

/** Case-insensitive, so /u/s_flow and /u/s_floW both resolve. */
export function playerByName(name: string): TrackedPlayer | undefined {
  const n = name.toLowerCase();
  return TRACKED_PLAYERS.find((p) => p.name.toLowerCase() === n);
}
