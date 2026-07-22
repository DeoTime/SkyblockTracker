import http from 'node:http';
import Database from 'better-sqlite3';
import { buildFlip, buildPending, summarizePending, summarize, profitSeries, byItem, rangeStart } from './flips.js';
import { itemMetadata } from './prices.js';
import { sweep, playerAuctions } from './sweep.js';
import {
  openSettings,
  makeSettingsStore,
  passwordOk,
  writeEnabled,
  enrollOk,
  enrollEnabled,
  looksLikeKey,
  verifyKey,
} from './settings.js';

/**
 * Read API over the ingest database. No framework: two dependencies is the
 * whole point, and this is four routes.
 *
 * Opened READONLY — the ingest is the only writer. Two processes writing the
 * same SQLite file across a container boundary is how you get a corrupt WAL.
 */

const DB_PATH = process.env.DB_PATH ?? '/data/skyblock.db';
const SETTINGS_PATH = process.env.SETTINGS_PATH ?? '/data/settings.db';
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const ORIGIN = process.env.CORS_ORIGIN ?? '*';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL'); // read the ingest's in-flight WAL, not a stale snapshot

const settings = makeSettingsStore(openSettings(SETTINGS_PATH));

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

/**
 * Rebuild a batch of flips with BOUNDED concurrency.
 *
 * A cold process has an empty NEU recipe cache, so every flip fans out into a
 * recursive tree of fetches to the NEU repo. Mapping a player's whole sale
 * history through Promise.all fired hundreds of those at once and kept every
 * intermediate alive, which pushed the 512MB container past its cgroup limit —
 * the kernel OOM-killed it mid-request (empty reply -> 502), and because it
 * died before finishing it never warmed the cache, so the next request did the
 * same thing. A small window keeps peak memory and fetch fan-out flat while
 * still warming fetchNeuItem/flipCache so every later request is a cache hit.
 */
const FLIP_CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const flipsFor = (uuid, from) => mapLimit(qSales.all(uuid, from), FLIP_CONCURRENCY, (r) => flipOf(r));

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
    // The dashboard table shows every flip in the range, not a preview. Capped
    // only so a prolific seller cannot produce an unbounded payload; past that
    // the "View all" link takes over the paginated endpoint.
    recentFlips: flips.slice(0, 500),
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

/**
 * A player's still-in-flight auctions, each priced for expected profit. This is
 * the one read that needs the stored key — everything else runs off the keyless
 * public book.
 */
async function pending(username) {
  const key = settings.apiKey();
  if (!key) throw new HttpError(503, 'No Hypixel key is installed. Add one on the settings page.');

  const player = await resolvePlayer(username);
  if (!player) throw new HttpError(404, `No Minecraft account named "${username}".`);

  const raw = await playerAuctions(player.uuid, key);
  const listings = await mapLimit(raw, FLIP_CONCURRENCY, (a) => buildPending(a, db));

  // Active first (ending soonest), then sold-pending-claim, then expired.
  const rank = { active: 0, sold: 1, expired: 2 };
  listings.sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(a.endsAt) - Date.parse(b.endsAt));

  return { player, generatedAt: new Date().toISOString(), listings, totals: summarizePending(listings) };
}

/* ---- snipe alerts --------------------------------------------------- */

/**
 * Prepared statements over snipe_alerts, resolved lazily. The ingest creates
 * that table; the API opens the DB readonly and may boot before the table
 * exists (or before the ingest is redeployed). We therefore prepare on first
 * use and cache only on success, so it starts working the moment the table
 * appears — without a hard crash at startup.
 */
let alertStmts = null;
function alerts() {
  if (alertStmts) return alertStmts;
  try {
    alertStmts = {
      recent: db.prepare('SELECT * FROM snipe_alerts ORDER BY id DESC LIMIT ?'),
      since: db.prepare('SELECT * FROM snipe_alerts WHERE id > ? ORDER BY id ASC'),
      maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM snipe_alerts'),
    };
  } catch {
    alertStmts = null; // table not there yet — retry next request
  }
  return alertStmts;
}

/**
 * The mod presents `Authorization: Bearer <token>`. Resolve it to the identity
 * it was issued to (username/uuid) via the token registry, or null if the token
 * is missing, unknown, or revoked. The registry hashes on lookup, so the raw
 * token is never compared or stored in plaintext.
 */
function streamIdentity(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] ?? '');
  if (!m) return null;
  return settings.matchStreamToken(m[1].trim());
}

/** DB row -> the JSON the mod/webhook consume. Mirrors ingest toPayload(). */
function alertPayload(r) {
  return {
    type: 'snipe',
    item: { id: r.item_id, name: r.item_name ?? r.item_id },
    auctionId: r.auction_id,
    price: r.price,
    baseline: r.baseline,
    estResale: r.est_resale,
    estProfit: r.est_profit,
    estMarginPct: r.margin_pct,
    seller: r.seller,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    detectedAt: new Date(r.detected_at).toISOString(),
    viewCommand: `/viewauction ${r.auction_id}`,
  };
}

/**
 * Issue or revoke a stream bearer token.
 *
 *   { password, username }        -> mint a token for that player; returned ONCE
 *   { code, username }            -> same, but authorised by the shared ENROLL_CODE
 *   { password, revoke: <sel> }   -> revoke by username or masked handle (admin only)
 *
 * Two credentials with different power: ADMIN_PASSWORD can do everything, while
 * ENROLL_CODE can ONLY mint — that is what the mod's `/snipe login` sends, so a
 * friend can enrol without being able to revoke anyone or touch the Hypixel key.
 *
 * The username is a LABEL for the person the token was handed to — it lets each
 * token be revoked on its own — not a verified assertion of who is connecting.
 * The uuid, resolved best-effort, is stored for future player-scoped filtering.
 */
async function issueStreamToken(req) {
  if (!writeEnabled() && !enrollEnabled()) {
    throw new HttpError(503, 'Token issuance is disabled: set ADMIN_PASSWORD or ENROLL_CODE.');
  }
  const body = await readJsonBody(req);
  const isAdmin = passwordOk(body.password);
  const isEnroll = enrollOk(body.code);
  if (!isAdmin && !isEnroll) throw new HttpError(401, 'Wrong password or enrol code.');

  if (body.revoke != null && body.revoke !== '') {
    if (!isAdmin) throw new HttpError(403, 'Revoking a token requires the admin password.');
    const selector = String(body.revoke).trim();
    const n = settings.revokeStreamToken(selector);
    if (!n) throw new HttpError(404, `No active token matched "${selector}".`);
    return { revoked: n, ...settings.streamTokenStatus() };
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) {
    throw new HttpError(400, 'A username is required so the token can be labelled and revoked individually.');
  }

  let uuid = null;
  try {
    uuid = (await resolvePlayer(username))?.uuid ?? null;
  } catch {
    /* Mojang unreachable — the token is still valid, just without a bound uuid */
  }

  const token = settings.issueStreamToken({ username, uuid });
  // Enrol responses stay minimal (the mod only needs the token); the admin path
  // also gets the full masked listing back for the dashboard.
  return isAdmin
    ? { token, username, uuid, ...settings.streamTokenStatus() }
    : { token, username };
}

/**
 * Server-Sent-Events stream of NEW alerts. Writes to the socket directly and
 * holds it open, so it bypasses the JSON send() path. Starts from the current
 * max id (history is the /alerts endpoint, not this one) and polls once a
 * second; a comment ping every 20s keeps the tunnel from idling the socket out.
 */
function startStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': ORIGIN,
  });
  res.write(': connected\n\n');

  // Prime the cursor to the current max exactly once, so the client gets only
  // alerts that arrive AFTER it connects (history lives at /alerts). `primed`
  // separates "table empty" (cursor 0 is correct, stream id>0) from "table not
  // created yet" (wait, then baseline once it appears) — without it the first
  // ever alert would be skipped.
  let cursor = 0;
  let primed = false;
  const first = alerts();
  if (first) {
    cursor = first.maxId.get().m;
    primed = true;
  }

  const poll = setInterval(() => {
    try {
      const a = alerts();
      if (!a) return;
      if (!primed) {
        cursor = a.maxId.get().m; // table just appeared: baseline once, skip history
        primed = true;
      }
      for (const row of a.since.all(cursor)) {
        cursor = row.id;
        res.write(`data: ${JSON.stringify(alertPayload(row))}\n\n`);
      }
    } catch {
      /* transient read error — try again next tick */
    }
  }, 1000);

  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);

  const stop = () => {
    clearInterval(poll);
    clearInterval(ping);
  };
  req.on('close', stop);
  req.on('error', stop);
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
  const flips = await mapLimit(qItemSales.all(itemId, uuid, uuid), FLIP_CONCURRENCY, (r) => flipOf(r));

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

/** Bounded so an oversized body cannot be used to exhaust memory. */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Body was not valid JSON.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'Could not read the request body.')));
  });
}

/**
 * Install a new Hypixel key.
 *
 * Two gates, in this order: the shared password, then Hypixel itself. The
 * client also validates, but a client check only reports what the client
 * claims — what gets persisted has to be a key THIS server watched Hypixel
 * accept.
 */
async function putApiKey(req) {
  if (!writeEnabled()) {
    throw new HttpError(503, 'Key updates are disabled: the server has no ADMIN_PASSWORD set.');
  }

  const body = await readJsonBody(req);
  if (!passwordOk(body.password)) throw new HttpError(401, 'Wrong password.');

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!looksLikeKey(key)) {
    throw new HttpError(400, 'That does not look like a Hypixel key — they are UUIDs, e.g. 1a2b3c4d-….');
  }

  // verifyKey throws plain Errors with user-facing text. Promote them to
  // HttpError so they reach the client instead of the 500 catch-all.
  let playerCount;
  try {
    ({ playerCount } = await verifyKey(key));
  } catch (e) {
    throw new HttpError(400, e.message);
  }

  settings.setApiKey(key);

  return {
    ...settings.apiKeyStatus(),
    message: `Key accepted and stored. Hypixel reports ${playerCount.toLocaleString('en-US')} players online.`,
  };
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
    });
    return res.end();
  }

  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);

  // POST exists only to install a key or (re)issue the stream token; the rest are reads.
  const POST_PATHS = new Set(['/key', '/alerts/token']);
  if (req.method === 'POST' && !POST_PATHS.has(p)) {
    return send(405, { error: 'Only GET is supported on this endpoint.' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(405, { error: 'Only GET and POST are supported.' });
  }

  try {
    if (p === '/key') {
      if (req.method === 'POST') return send(200, await putApiKey(req));
      // Status only — the key itself is never sent back over the wire.
      return send(200, { ...settings.apiKeyStatus(), writable: writeEnabled() });
    }

    if (p === '/alerts/token') {
      if (req.method === 'POST') return send(200, await issueStreamToken(req));
      // Status only — a masked listing of who holds a token; the tokens
      // themselves are shown once, at issue time.
      return send(200, { ...settings.streamTokenStatus(), writable: writeEnabled(), enrollOpen: enrollEnabled() });
    }

    if (p === '/alerts/stream') {
      if (!streamIdentity(req)) throw new HttpError(401, 'Missing or invalid bearer token.');
      return startStream(req, res); // holds the socket open; no send()
    }

    if (p === '/alerts') {
      if (!streamIdentity(req)) throw new HttpError(401, 'Missing or invalid bearer token.');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      const rows = alerts()?.recent.all(limit) ?? [];
      return send(200, { alerts: rows.map(alertPayload) });
    }

    if (p === '/sweep') {
      const list = (name) => (url.searchParams.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return send(200, await sweep({
        sellers: list('sellers'),
        names: list('names'),
        excludeSellers: list('excludeSellers'),
      }));
    }

    if (seg[0] === 'players' && seg[2] === 'auctions') {
      const key = settings.apiKey();
      if (!key) throw new HttpError(503, 'No Hypixel key is installed. Add one on the settings page.');
      const player = await resolvePlayer(seg[1]);
      if (!player) throw new HttpError(404, `No Minecraft account named "${seg[1]}".`);
      return send(200, { player, auctions: await playerAuctions(player.uuid, key) });
    }

    if (seg[0] === 'players' && seg[2] === 'pending') {
      return send(200, await pending(seg[1]));
    }

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

// Node defaults requestTimeout to 5 min, which would sever the SSE stream.
// The stream is meant to stay open; disable the per-request cap. Keep-alive
// pings (and the mod's own reconnect) handle genuinely dead sockets.
server.requestTimeout = 0;

server.listen(PORT, HOST, () => console.log(`api listening on ${HOST}:${PORT} (db ${DB_PATH})`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
