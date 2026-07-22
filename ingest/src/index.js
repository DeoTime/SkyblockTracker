import { openDb, makeStatements } from './db.js';
import { decodeItem } from './decode.js';
import { loadSnipeConfig, makeSnipe } from './snipe.js';

/**
 * Continuous capture of Hypixel SkyBlock sales and bazaar prices.
 *
 * Both endpoints used here are KEYLESS, so a credential outage can never cause
 * permanent data loss — which matters because none of this can be backfilled.
 *
 * The ended-auctions feed is a 60-second window whose snapshots do NOT overlap:
 * two polls 25s apart return a byte-identical set, then the next rotation is a
 * wholly new one. Polling at 60s therefore drops an entire slice (~140 sales) on
 * any drift. We poll at 20s and dedupe on auction_id.
 */

const API = 'https://api.hypixel.net/v2';

const TRACKED = new Set(
  (process.env.TRACKED_UUIDS ??
    '826bf8088bf9406a88b1bf2242f1d317,b7e55bf27a754acc9f105cb5472a6997')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const DB_PATH = process.env.DB_PATH ?? '/data/skyblock.db';
const ENDED_INTERVAL = Number(process.env.ENDED_INTERVAL_MS ?? 20_000);
const BAZAAR_INTERVAL = Number(process.env.BAZAAR_INTERVAL_MS ?? 60_000);
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const BAZAAR_MOVE = 0.005; // write on >0.5% move
const BAZAAR_HEARTBEAT_MS = 5 * 60 * 1000;

const db = openDb(DB_PATH);
const st = makeStatements(db);

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, finishing current cycle`);
    stopping = true;
  });
}

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false) throw new Error(`${path} -> success:false`);
  return body;
}

/* ---------------- ended auctions ---------------- */

const insertBatch = db.transaction((rows) => {
  for (const r of rows) {
    st.seen.run(r.auction_id, r.ingested_at);
    if (r.tracked) st.insertTracked.run(r.tracked);
    else st.upsertRollup.run(r.rollup);
  }
});

async function pollEnded() {
  const body = await getJson('/skyblock/auctions_ended');
  const now = Date.now();
  const rows = [];

  for (const a of body.auctions) {
    if (st.wasSeen.get(a.auction_id)) continue;

    let decoded = null;
    try {
      decoded = await decodeItem(a.item_bytes);
    } catch {
      /* undecodable blob — still record the sale, just without item detail */
    }

    const itemId = decoded?.itemId ?? null;
    const isTracked = TRACKED.has(a.seller);

    if (isTracked) {
      rows.push({
        auction_id: a.auction_id,
        ingested_at: now,
        tracked: {
          auction_id: a.auction_id,
          seller: a.seller,
          seller_profile: a.seller_profile ?? null,
          buyer: a.buyer ?? null,
          sold_at: a.timestamp,
          price: a.price,
          bin: a.bin ? 1 : 0,
          item_id: itemId,
          crafted_at: decoded?.craftedAt ?? null,
          upgrades: decoded ? JSON.stringify(decoded.upgrades) : null,
          item_bytes: a.item_bytes,
          ingested_at: now,
        },
      });
    } else if (itemId) {
      rows.push({
        auction_id: a.auction_id,
        ingested_at: now,
        rollup: {
          item_id: itemId,
          hour: Math.floor(a.timestamp / 3_600_000),
          is_clean: decoded.isClean ? 1 : 0,
          price: a.price,
        },
      });
    } else {
      rows.push({ auction_id: a.auction_id, ingested_at: now });
    }
  }

  if (rows.length) insertBatch(rows);

  const trackedCount = rows.filter((r) => r.tracked).length;
  st.log.run(now, 'ended', body.auctions.length, rows.length, trackedCount ? `tracked:${trackedCount}` : null);

  if (rows.length || trackedCount) {
    log(`ended: ${body.auctions.length} returned, ${rows.length} new${trackedCount ? `, ${trackedCount} TRACKED` : ''}`);
  }
  if (trackedCount) {
    for (const r of rows.filter((x) => x.tracked)) {
      log(`  >> ${r.tracked.item_id} sold for ${r.tracked.price.toLocaleString('en-US')} by ${r.tracked.seller.slice(0, 8)}`);
    }
  }
}

/* ---------------- bazaar ---------------- */

const lastWrite = new Map();

const writeBazaar = db.transaction((rows) => {
  for (const r of rows) st.insertBazaar.run(r.id, r.ts, r.buy, r.sell);
});

async function pollBazaar() {
  const body = await getJson('/skyblock/bazaar');
  const now = Date.now();
  const rows = [];

  for (const [id, p] of Object.entries(body.products)) {
    const q = p.quick_status;
    if (!q) continue;

    const prev = lastWrite.get(id);
    const moved =
      !prev ||
      now - prev.ts > BAZAAR_HEARTBEAT_MS ||
      Math.abs(q.buyPrice - prev.buy) > Math.abs(prev.buy || 1) * BAZAAR_MOVE ||
      Math.abs(q.sellPrice - prev.sell) > Math.abs(prev.sell || 1) * BAZAAR_MOVE;

    if (!moved) continue;
    rows.push({ id, ts: now, buy: q.buyPrice, sell: q.sellPrice });
    lastWrite.set(id, { ts: now, buy: q.buyPrice, sell: q.sellPrice });
  }

  if (rows.length) writeBazaar(rows);
  st.log.run(now, 'bazaar', Object.keys(body.products).length, rows.length, null);
  log(`bazaar: ${rows.length} products written`);
}

/* ---------------- loops ---------------- */

async function loop(name, fn, interval) {
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      log(`${name} ERROR: ${err.message}`);
    }
    const wait = Math.max(1000, interval - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

const ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

setInterval(
  () => {
    try {
      const cut = Date.now() - SEEN_TTL_MS;
      const n = st.pruneSeen.run(cut).changes;
      if (n) log(`pruned ${n} dedupe keys`);
      const a = st.pruneAlerts.run(Date.now() - ALERT_TTL_MS).changes;
      if (a) log(`pruned ${a} old snipe alerts`);
    } catch (err) {
      log(`prune ERROR: ${err.message}`);
    }
  },
  30 * 60 * 1000,
).unref();

log(`starting — db ${DB_PATH}`);
log(`tracking ${TRACKED.size} sellers: ${[...TRACKED].map((u) => u.slice(0, 8)).join(', ')}`);
log(`ended every ${ENDED_INTERVAL}ms, bazaar every ${BAZAAR_INTERVAL}ms, no API key required`);

const loops = [
  loop('ended', pollEnded, ENDED_INTERVAL),
  loop('bazaar', pollBazaar, BAZAAR_INTERVAL),
];

const snipeCfg = loadSnipeConfig();
if (snipeCfg) {
  const pollSnipe = makeSnipe(db, log, snipeCfg);
  loops.push(loop('snipe', pollSnipe, snipeCfg.intervalMs));
  log(
    `snipe: watching ${snipeCfg.watch.map((w) => w.id).join(', ')} — ` +
      `drop>=${Math.round(snipeCfg.dropThreshold * 100)}%, minProfit ${snipeCfg.minProfit.toLocaleString('en-US')}` +
      (snipeCfg.dryRun ? ' [DRY RUN]' : '') +
      (snipeCfg.webhookUrl ? ' + webhook' : ''),
  );
} else {
  log('snipe: disabled (set SNIPE_ENABLED=1 to enable)');
}

await Promise.all(loops);

log('stopped cleanly');
db.close();
