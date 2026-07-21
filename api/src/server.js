import http from 'node:http';
import Database from 'better-sqlite3';
import { buildFlip, summarize, profitSeries, byItem, rangeStart } from './flips.js';
import { itemMetadata } from './prices.js';

/**
 * Read API over the ingest database. No framework: two dependencies is the
 * whole point, and this is four routes.
 *
 * Opened READONLY — the ingest is the only writer. Two processes writing the
 * same SQLite file across a container boundary is how you get a corrupt WAL.
 */

const DB_PATH = process.env.DB_PATH ?? '/data/skyblock.db';
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const ORIGIN = process.env.CORS_ORIGIN ?? '*';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL'); // read the ingest's in-flight WAL, not a stale snapshot

/* ---- player identity ---------------------------------------------- */

const SEED = new Map([
  ['s_flow', '826bf8088bf9406a88b1bf2242f1d317'],
  ['cloudyv2', 'b7e55bf27a754acc9f105cb5472a6997'],
]);

const nameCache = new Map(); // uuid -> display name
const uuidCache = new Map([...SEED]); // lowercased name -> uuid

async function resolvePlayer(username) {
  const key = username.toLowerCase();
  const cached = uuidCache.get(key);
  if (cached) return { uuid: cached, username };

  try {
    const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
    if (!r.ok) return null;
    const j = await r.json();
    uuidCache.set(key, j.id);
    nameCache.set(j.id, j.name);
    return { uuid: j.id, username: j.name };
  } catch {
    return null;
  }
}

/* ---- queries -------------------------------------------------------- */

const qSales = db.prepare(
  `SELECT * FROM tracked_sales WHERE seller = ? AND sold_at >= ? ORDER BY sold_at DESC`,
);
const qSale = db.prepare('SELECT * FROM tracked_sales WHERE auction_id = ?');
const qItemSales = db.prepare(
  `SELECT * FROM tracked_sales WHERE item_id = ? AND (? IS NULL OR seller = ?) ORDER BY sold_at DESC`,
);
const qItemHistory = db.prepare(
  `SELECT hour, min_price, sum_price, sales FROM price_rollup
    WHERE item_id = ? AND is_clean = 1 ORDER BY hour ASC`,
);

/**
 * Building a flip costs several NEU fetches, and a dashboard rebuilds every
 * flip on every request. Sales are immutable once ended, so cache on the
 * auction id; only the two `current*` fields in detail go stale, and those are
 * cached separately with a TTL.
 */
const flipCache = new Map();
const DETAIL_TTL = 10 * 60_000;

async function flipOf(row, detail = false) {
  const key = `${row.auction_id}:${detail ? 'd' : 's'}`;
  const hit = flipCache.get(key);
  if (hit && (!detail || Date.now() - hit.at < DETAIL_TTL)) return hit.value;

  const value = await buildFlip(row, db, { detail });
  flipCache.set(key, { value, at: Date.now() });
  return value;
}

const flipsFor = (uuid, from) => Promise.all(qSales.all(uuid, from).map((r) => flipOf(r)));

/* ---- handlers ------------------------------------------------------- */

async function dashboard(username, range) {
  const player = await resolvePlayer(username);
  if (!player) throw new HttpError(404, `No Minecraft account named "${username}".`);

  const from = rangeStart(range);
  const flips = await flipsFor(player.uuid, from);

  return {
    player,
    range,
    stats: summarize(flips),
    profitSeries: profitSeries(flips, from || undefined),
    byItem: byItem(flips),
    recentFlips: flips.slice(0, 12),
  };
}

async function flipsPage(username, range, page, pageSize) {
  const player = await resolvePlayer(username);
  if (!player) throw new HttpError(404, `No Minecraft account named "${username}".`);

  const all = await flipsFor(player.uuid, rangeStart(range));
  return {
    player,
    flips: all.slice(page * pageSize, page * pageSize + pageSize),
    page,
    pageSize,
    totalFlips: all.length,
    totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
  };
}

async function flipDetail(auctionUuid) {
  const row = qSale.get(auctionUuid);
  if (!row) throw new HttpError(404, 'That flip is not in the database.');
  return flipOf(row, true);
}

async function itemHistory(itemId, username) {
  const meta = (await itemMetadata()).get(itemId);
  const player = username ? await resolvePlayer(username) : null;

  const rows = qItemHistory.all(itemId);
  const byDay = new Map();
  for (const r of rows) {
    const date = new Date(r.hour * 3600_000).toISOString().slice(0, 10);
    const d = byDay.get(date) ?? { sum: 0, sales: 0 };
    d.sum += r.sum_price;
    d.sales += r.sales;
    byDay.set(date, d);
  }

  const uuid = player?.uuid ?? null;
  const flips = await Promise.all(qItemSales.all(itemId, uuid, uuid).map((r) => flipOf(r)));

  return {
    itemId,
    itemName: meta?.name ?? itemId,
    rarity: meta?.tier ?? 'COMMON',
    points: [...byDay.entries()].map(([date, d]) => ({
      date,
      // We store realised sale prices, not craft costs, per hour. Reconstructing
      // a historical craft cost per day would mean re-costing the recipe at
      // every point; null is honest until that job exists.
      craftCost: null,
      marketPrice: Math.round(d.sum / d.sales),
    })),
    flips,
  };
}

/* ---- plumbing ------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ORIGIN,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
    });
    return res.end();
  }
  if (req.method !== 'GET') return send(405, { error: 'Only GET is supported.' });

  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    if (p === '/health') {
      const { c } = db.prepare('SELECT COUNT(*) c FROM tracked_sales').get();
      return send(200, { ok: true, trackedSales: c });
    }

    if (seg[0] === 'players' && seg[2] === 'dashboard') {
      return send(200, await dashboard(seg[1], url.searchParams.get('range') ?? '30d'));
    }

    if (seg[0] === 'players' && seg[2] === 'flips') {
      const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0);
      const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? 50) || 50));
      return send(200, await flipsPage(seg[1], url.searchParams.get('range') ?? '30d', page, pageSize));
    }

    if (seg[0] === 'flips' && seg[1]) return send(200, await flipDetail(seg[1]));

    if (seg[0] === 'items' && seg[2] === 'history') {
      return send(200, await itemHistory(seg[1], url.searchParams.get('player') ?? undefined));
    }

    send(404, { error: 'No such endpoint.' });
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, { error: err.message });
    console.error(err);
    // The frontend renders this string verbatim, so it is written for a person.
    send(500, { error: 'Could not build that response. The server log has details.' });
  }
});

server.listen(PORT, HOST, () => console.log(`api listening on ${HOST}:${PORT} (db ${DB_PATH})`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
