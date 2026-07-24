import Database from 'better-sqlite3';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

/**
 * Server-side settings, including the Hypixel API key.
 *
 * Deliberately a SEPARATE database file from skyblock.db. The ingest writes
 * that one every 20 seconds and the API opens it readonly; adding a second
 * writer to it would put settings writes in contention with the poller for no
 * benefit. This file is tiny and written a handful of times a year.
 */

const WRITE_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

// A low-privilege shared "invite code" whose ONLY power is minting a stream
// token for the caller. Distinct from ADMIN_PASSWORD (which can also revoke
// tokens and change the Hypixel key) so it can be handed to friends without
// giving away the master credential. Unset -> mod enrolment is closed.
const ENROLL_CODE = process.env.ENROLL_CODE ?? '';

export function openSettings(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      name       TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- One row per issued stream token, labelled by the Minecraft username it was
    -- handed to, so tokens can be revoked one person at a time. The token itself
    -- is NEVER stored — only its sha256, so a leak of this DB does not leak a
    -- working credential. 'masked' is a display/revoke handle, 'uuid' is a
    -- best-effort resolution kept for later player-scoped filtering.
    CREATE TABLE IF NOT EXISTS stream_tokens (
      token_hash TEXT PRIMARY KEY,
      masked     TEXT NOT NULL,
      username   TEXT NOT NULL,
      uuid       TEXT,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_stream_tokens_user ON stream_tokens(username);

    -- Flips the operator has hidden from every aggregate. The row is a curation
    -- decision (a mispriced sale, a gift, a test listing), so it must survive
    -- restarts — hence here, in the writable settings DB, and not in memory. The
    -- sale itself still lives untouched in the readonly ingest DB; this only
    -- controls whether it counts.
    CREATE TABLE IF NOT EXISTS excluded_flips (
      auction_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Constant-time comparison against the configured password.
 *
 * Both sides are hashed first so the compare operates on equal-length buffers —
 * timingSafeEqual throws on a length mismatch, and that throw would itself leak
 * the password's length.
 */
export function passwordOk(supplied) {
  if (!WRITE_PASSWORD) return false; // unset means the endpoint is closed, not open
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(WRITE_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

export const writeEnabled = () => WRITE_PASSWORD.length > 0;

/** Whether mod self-enrolment is open (an ENROLL_CODE is configured). */
export const enrollEnabled = () => ENROLL_CODE.length > 0;

/**
 * Constant-time check of a supplied enrol code against ENROLL_CODE. Same hashing
 * dance as passwordOk so timingSafeEqual sees equal-length buffers and the code's
 * length never leaks.
 */
export function enrollOk(supplied) {
  if (!ENROLL_CODE) return false;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(ENROLL_CODE).digest();
  return timingSafeEqual(a, b);
}

/** A fresh opaque bearer token for the alert stream. */
export const newToken = () => randomBytes(24).toString('hex');

/** sha256 hex of a token — what we store and index on, never the token itself. */
const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

/** Hypixel keys are UUIDs. Rejects obvious junk before spending a request. */
export const looksLikeKey = (k) =>
  typeof k === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k.trim());

/**
 * Never return the key itself over HTTP. The page only needs to show which key
 * is installed, and a masked form is enough to tell two keys apart.
 */
export const maskKey = (k) => (k && k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••');

export function makeSettingsStore(db) {
  const get = db.prepare('SELECT value, updated_at FROM settings WHERE name = ?');
  const put = db.prepare(`
    INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const insTok = db.prepare(
    `INSERT INTO stream_tokens (token_hash, masked, username, uuid, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const findTok = db.prepare(`SELECT * FROM stream_tokens WHERE token_hash = ? AND revoked_at IS NULL`);
  const touchTok = db.prepare(`UPDATE stream_tokens SET last_seen = ? WHERE token_hash = ?`);
  const listTok = db.prepare(
    `SELECT username, masked, uuid, created_at, last_seen, revoked_at
       FROM stream_tokens ORDER BY (revoked_at IS NOT NULL), created_at DESC`,
  );
  // Revoke by username (all a person's active tokens) OR by the masked handle
  // (one specific token when a name has several).
  const revokeByUser = db.prepare(
    `UPDATE stream_tokens SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL`,
  );
  const revokeByMask = db.prepare(
    `UPDATE stream_tokens SET revoked_at = ? WHERE masked = ? AND revoked_at IS NULL`,
  );

  const insExcl = db.prepare(`INSERT OR IGNORE INTO excluded_flips (auction_id, created_at) VALUES (?, ?)`);
  const delExcl = db.prepare(`DELETE FROM excluded_flips WHERE auction_id = ?`);
  const allExcl = db.prepare(`SELECT auction_id FROM excluded_flips`);

  // One-time migration: an earlier build stored a single global token in the
  // settings table. Fold it into the registry under 'legacy' so it keeps working
  // until the owner reissues, then drop the old row.
  const legacy = get.get('stream_token');
  if (legacy?.value) {
    const h = tokenHash(legacy.value);
    if (!db.prepare('SELECT 1 FROM stream_tokens WHERE token_hash = ?').get(h)) {
      insTok.run(h, maskKey(legacy.value), 'legacy', null, legacy.updated_at ?? Date.now());
    }
    db.prepare('DELETE FROM settings WHERE name = ?').run('stream_token');
  }

  const tokenRow = (r) => ({
    username: r.username,
    masked: r.masked,
    uuid: r.uuid,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    revoked: r.revoked_at != null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  });

  return {
    apiKey: () => get.get('hypixel_api_key')?.value ?? null,
    apiKeyStatus: () => {
      const row = get.get('hypixel_api_key');
      return row
        ? { configured: true, masked: maskKey(row.value), updatedAt: new Date(row.updated_at).toISOString() }
        : { configured: false, masked: null, updatedAt: null };
    },
    setApiKey: (key) => put.run('hypixel_api_key', key.trim(), Date.now()),

    /**
     * Mint a stream token bound to a Minecraft username. Returns the plaintext
     * token ONCE (only its hash is stored) — the caller must hand it back to the
     * user immediately, as it can never be recovered.
     */
    issueStreamToken: ({ username, uuid = null }) => {
      const token = newToken();
      insTok.run(tokenHash(token), maskKey(token), username, uuid, Date.now());
      return token;
    },

    /**
     * Look up the identity behind a presented bearer token. Returns the token's
     * row (username/uuid) if it is valid and not revoked, else null; touches
     * last_seen so the listing shows who is actually connected.
     */
    matchStreamToken: (presented) => {
      const row = findTok.get(tokenHash(presented));
      if (!row) return null;
      touchTok.run(Date.now(), row.token_hash);
      return { username: row.username, uuid: row.uuid, masked: row.masked };
    },

    /** Revoke every active token for a username, or one token by its masked handle. */
    revokeStreamToken: (selector) => {
      const now = Date.now();
      const byUser = revokeByUser.run(now, selector).changes;
      return byUser || revokeByMask.run(now, selector).changes;
    },

    /** The set of auction ids the operator has excluded from every aggregate. */
    excludedFlips: () => new Set(allExcl.all().map((r) => r.auction_id)),

    /**
     * Add or remove a flip from the exclusion set. Idempotent — excluding an
     * already-excluded flip (or including an already-included one) is a no-op.
     */
    setFlipExcluded: (auctionId, excluded) => {
      if (excluded) insExcl.run(auctionId, Date.now());
      else delExcl.run(auctionId);
      return excluded;
    },

    /** Masked listing of all tokens (active first) — no secret is ever returned. */
    listStreamTokens: () => listTok.all().map(tokenRow),
    streamTokenStatus: () => {
      const rows = listTok.all();
      const active = rows.filter((r) => r.revoked_at == null);
      return { configured: active.length > 0, count: active.length, tokens: rows.map(tokenRow) };
    },
  };
}

/**
 * Prove a key works before storing it. The client checks this too, but a client
 * check only tells us what the client claims — the key we persist has to be one
 * this server has seen Hypixel accept.
 */
export async function verifyKey(key) {
  const res = await fetch('https://api.hypixel.net/v2/counts', { headers: { 'API-Key': key } });
  if (res.status === 403) throw new Error('Hypixel rejected that key.');
  if (res.status === 429) throw new Error('Rate limited while checking the key — try again in a minute.');
  if (!res.ok) throw new Error(`Hypixel returned ${res.status} while checking the key.`);
  const body = await res.json();
  return { playerCount: body.playerCount ?? 0 };
}
