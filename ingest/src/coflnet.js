import { normalizeItemUuid } from './decode.js';

/**
 * Purchases, backfilled from Coflnet.
 *
 * The live ended-auctions feed (index.js) records a purchase the moment it
 * happens, with raw NBT, and cannot see one second into the past — Hypixel's
 * window is 60 seconds wide and non-overlapping, so everything bought before
 * that loop started is simply gone. That is the whole limitation this module
 * exists to remove: Coflnet keeps auction history, so a player's past buys can
 * be recovered and matched to sales they have already made.
 *
 * The two writers are complements, not alternatives:
 *
 *   hypixel  real-time, raw NBT, forward-only
 *   coflnet  reaches backwards, flattened NBT only, rate-limited
 *
 * Both INSERT OR IGNORE into tracked_buys, so whichever sees an auction first
 * keeps it. The live feed's row is the better one (it has item_bytes), and in
 * practice it wins for anything bought while the ingest is up.
 *
 * ⚠ Coflnet requires ATTRIBUTION IN THE UI, and commercial use requires
 * Premium+. See api/src/sales.js — the same terms cover this.
 */

const COFL = 'https://sky.coflnet.com/api';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Coflnet stamps times without a zone; they are UTC. Parsing them as local
 * silently shifts every purchase by the host's offset, which on a resell would
 * move a buy to the wrong side of its own sale.
 */
const utc = (s) => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s.endsWith('Z') ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Returns config, or null when the feature is off (the safe default). */
export function loadCoflnetConfig(env = process.env) {
  const on =
    env.COFLNET_BUYS_ENABLED === '1' || (env.COFLNET_BUYS_ENABLED ?? '').toLowerCase() === 'true';
  if (!on) return null;

  const tracked = (env.TRACKED_UUIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    // Falls back to index.js's own default pair when TRACKED_UUIDS is unset, so
    // the two loops can never end up watching different players.
    players: tracked.length
      ? tracked
      : ['826bf8088bf9406a88b1bf2242f1d317', 'b7e55bf27a754acc9f105cb5472a6997'],

    // A catch-up pass, not a hot path — the live feed already has anything
    // bought since the ingest came up. Ten minutes is frequent enough to close
    // a gap left by a restart without spending the rate limit on nothing.
    intervalMs: num(env.COFLNET_INTERVAL_MS, 10 * 60_000),

    /**
     * The documented limit is 30 req/10s and 100/min per IP. 750ms leaves this
     * loop at ~80/min at its very fastest, with room for the rest of the
     * process. Deliberately slower than sales.js's 350ms: that runs in bursts
     * on a user request, this runs forever.
     */
    gapMs: num(env.COFLNET_GAP_MS, 750),

    // /bids pages 10 at a time, newest first. 40 pages ≈ 400 bids per pass.
    maxPages: num(env.COFLNET_MAX_PAGES, 40),
    // Detail fetches are the expensive half; cap them so a first run on a heavy
    // trader spreads over several passes instead of one long hammering.
    maxDetails: num(env.COFLNET_MAX_DETAILS, 60),
    // Do not walk history forever. 90 days is well past any flip worth costing.
    horizonDays: num(env.COFLNET_HORIZON_DAYS, 90),
  };
}

async function getJson(path, timeoutMs = 20_000) {
  const res = await fetch(`${COFL}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Upgrade fingerprint                                                 */
/* ------------------------------------------------------------------ */

/**
 * Cost-bearing keys AS COFLNET FLATTENS THEM.
 *
 * Kept in step with api/src/sales.js's FLAT_UPGRADE_KEYS, which was validated
 * against a couple of thousand real sales. Notably NOT decode.js's raw-NBT
 * list: Coflnet renames several (hot_potato_count -> hpc, dungeon_item_level ->
 * dungeon_item) and lifts enchantments out into their own array, so reusing the
 * raw names here would fingerprint a starred, potatoed sword as bare.
 */
const FLAT_UPGRADE_KEYS = new Set([
  'ethermerge',
  'rarity_upgrades',
  'tuned_transmission',
  'ability_scroll',
  'power_ability_scroll',
  'art_of_war_count',
  'hpc',
  'dungeon_item',
  'modifier',
  'skin',
  'dye_item',
  'upgrade_level',
  'talisman_enrichment',
  'mana_disintegrator_count',
  'wood_singularity_count',
  'farming_for_dummies_count',
]);

const GEM_SLOT = /^[A-Z]+_\d+$/;
const RUNE = /^RUNE_/;
const KNOWN_FREE = new Set(['uid', 'uuid', 'timestamp', 'originTag', 'bossId', 'item_tier', 'color', 'cc']);

/**
 * The cost-bearing upgrade set of one Coflnet auction, sorted and deduped.
 *
 * This is what stands in for the raw NBT these rows do not come with. The API
 * compares it against the same fingerprint taken from the SOLD item: equal sets
 * mean nothing was added between buying and selling, so the price paid is the
 * entire cost basis. Anything else falls back to charging every upgrade, which
 * overstates cost rather than profit.
 */
export function flatUpgradeSetOf(auction) {
  const flat = auction?.flatNbt ?? auction?.nbtData?.data ?? {};
  const set = new Set();

  for (const key of Object.keys(flat)) {
    if (FLAT_UPGRADE_KEYS.has(key)) set.add(key);
    else if (RUNE.test(key)) set.add('runes');
    else if (GEM_SLOT.test(key.split('.')[0]) && !KNOWN_FREE.has(key)) set.add('gems');
  }

  if (Array.isArray(auction?.enchantments) && auction.enchantments.length > 0) set.add('enchantments');
  // A reforge is a modifier by another name, and Coflnet reports it on its own
  // field as well as (sometimes) in the flat map.
  if (auction?.reforge && auction.reforge !== 'None') set.add('modifier');

  return [...set].sort();
}

/* ------------------------------------------------------------------ */
/* Backfill                                                            */
/* ------------------------------------------------------------------ */

/**
 * Did our player actually WIN this auction?
 *
 * The bids feed lists everything they bid on, losses included. `highestOwnBid >=
 * highestBid` is the cheap filter; the detail call then confirms it against the
 * real bid list, because booking a lost auction as a purchase would invent a
 * cost basis out of a bid that never bought anything.
 */
function wonBy(auction, player) {
  const bids = Array.isArray(auction?.bids) ? auction.bids : [];
  if (bids.length === 0) return null;

  const top = bids.reduce((a, b) => (Number(b.amount ?? 0) > Number(a.amount ?? 0) ? b : a));
  if (top.bidder !== player) return null;
  return { price: Math.round(Number(top.amount ?? 0)), at: utc(top.timestamp) };
}

export function makeCoflnetBuys(db, st, log, cfg) {
  const insert = db.transaction((rows) => {
    for (const r of rows) {
      st.insertBuy.run(r.buy);
      st.markCoflChecked.run(r.buy.auction_id, r.checked_at, 1);
    }
  });

  return async function pollCoflnetBuys() {
    const now = Date.now();
    const horizon = now - cfg.horizonDays * 86400_000;
    let requests = 0;
    let details = 0;
    let found = 0;

    for (const player of cfg.players) {
      let reachedHorizon = false;

      for (let page = 0; page < cfg.maxPages && !reachedHorizon; page++) {
        if (requests > 0) await sleep(cfg.gapMs);

        let bids;
        try {
          bids = await getJson(`/player/${player}/bids?page=${page}`);
        } catch (err) {
          // One bad page must not abort the pass; the next one will retry from
          // the top, and coflnet_checked means nothing already done is redone.
          log(`coflnet: ${player.slice(0, 8)} page ${page} failed: ${err.message}`);
          break;
        }
        requests += 1;
        if (!Array.isArray(bids) || bids.length === 0) break;

        const pending = [];
        for (const b of bids) {
          const endMs = utc(b.end);
          if (endMs === null) continue;
          if (endMs < horizon) {
            reachedHorizon = true;
            continue;
          }
          // Still running: no purchase has happened yet, and marking it checked
          // now would mean never looking again once it does.
          if (endMs > now) continue;
          if (st.wasCoflChecked.get(b.auctionId)) continue;
          // Outbid — cheap reject before spending a request on the detail.
          if (Number(b.highestOwnBid ?? 0) < Number(b.highestBid ?? 0)) {
            st.markCoflChecked.run(b.auctionId, now, 0);
            continue;
          }
          pending.push(b);
        }

        for (const b of pending) {
          if (details >= cfg.maxDetails) break;
          await sleep(cfg.gapMs);

          let a;
          try {
            a = await getJson(`/auction/${b.auctionId}`);
          } catch (err) {
            log(`coflnet: auction ${b.auctionId.slice(0, 8)} failed: ${err.message}`);
            continue;
          }
          requests += 1;
          details += 1;

          const win = wonBy(a, player);
          const itemUuid = normalizeItemUuid(a?.flatNbt?.uuid ?? a?.nbtData?.data?.uuid ?? null);

          // Recorded either way: a loss checked once should never be fetched
          // again, and a win with no item uuid (stackables have none) can never
          // join to a sale, so re-reading it would buy nothing.
          if (!win || !itemUuid) {
            st.markCoflChecked.run(b.auctionId, now, 0);
            continue;
          }

          const boughtAt = utc(a.end) ?? win.at ?? Date.now();
          insert([
            {
              checked_at: now,
              buy: {
                auction_id: b.auctionId,
                buyer: player,
                seller: a.auctioneerId ?? null,
                bought_at: boughtAt,
                price: win.price,
                bin: a.bin ? 1 : 0,
                item_id: a.tag ?? null,
                item_uuid: itemUuid,
                // Coflnet serves flattened NBT, never the raw blob.
                item_bytes: null,
                source: 'coflnet',
                upgrade_keys: JSON.stringify(flatUpgradeSetOf(a)),
                ingested_at: now,
              },
            },
          ]);
          found += 1;
          log(
            `  << ${a.tag} bought for ${win.price.toLocaleString('en-US')} by ${player.slice(0, 8)}` +
              ` [${itemUuid.slice(0, 8)}] via coflnet`,
          );
        }

        if (details >= cfg.maxDetails) break;
      }
    }

    st.log.run(Date.now(), 'coflnet', requests, found, `details:${details}`);
    if (found || details) {
      log(`coflnet: ${requests} requests, ${details} auctions examined, ${found} purchases recorded`);
    }
  };
}
