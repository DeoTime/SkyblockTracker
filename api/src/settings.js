import Database from 'better-sqlite3';
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Server-side settings, including the Hypixel API key.
 *
 * Deliberately a SEPARATE database file from skyblock.db. The ingest writes
 * that one every 20 seconds and the API opens it readonly; adding a second
 * writer to it would put settings writes in contention with the poller for no
 * benefit. This file is tiny and written a handful of times a year.
 */

const WRITE_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

export function openSettings(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      name       TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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

  return {
    apiKey: () => get.get('hypixel_api_key')?.value ?? null,
    apiKeyStatus: () => {
      const row = get.get('hypixel_api_key');
      return row
        ? { configured: true, masked: maskKey(row.value), updatedAt: new Date(row.updated_at).toISOString() }
        : { configured: false, masked: null, updatedAt: null };
    },
    setApiKey: (key) => put.run('hypixel_api_key', key.trim(), Date.now()),
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
