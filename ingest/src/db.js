import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Storage strategy — this is the whole reason the footprint is ~1.4 MB/day
 * instead of ~262 MB/day.
 *
 * Measured: ~149 sales per 60s window, ~214,000/day, ~1280 bytes of NBT each.
 * Keeping every sale's raw NBT is 93 GB/year for data that is 99.99% about
 * players we do not track.
 *
 * But we cannot simply drop everyone else either: pricing OUR players' cost
 * basis needs to know what an Etherwarp Conduit or a clean Aspect of the Void
 * was actually selling for at that time, and those are other people's sales.
 *
 * So we keep two different shapes:
 *
 *   tracked_sales  full fidelity, raw NBT, for our players only (~20 rows/day)
 *   price_rollup   per (item, hour, clean?) min/max/count for EVERYONE, no NBT
 *
 * The rollup is what makes historical cost basis possible; the raw rows are
 * what make a flip auditable. Neither alone is sufficient.
 */

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    -- Full detail, tracked sellers only.
    CREATE TABLE IF NOT EXISTS tracked_sales (
      auction_id     TEXT PRIMARY KEY,
      seller         TEXT NOT NULL,
      seller_profile TEXT,
      buyer          TEXT,
      sold_at        INTEGER NOT NULL,
      price          INTEGER NOT NULL,
      bin            INTEGER NOT NULL,
      item_id        TEXT,
      crafted_at     INTEGER,
      upgrades       TEXT,
      item_bytes     TEXT,
      ingested_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_seller ON tracked_sales(seller, sold_at DESC);

    -- Everyone's sales, collapsed to hourly price stats. No NBT retained.
    -- is_clean separates base-item prices from upgraded ones: mixing them is
    -- how a tracker ends up pricing someone else's enchants into your base.
    CREATE TABLE IF NOT EXISTS price_rollup (
      item_id   TEXT    NOT NULL,
      hour      INTEGER NOT NULL,
      is_clean  INTEGER NOT NULL,
      min_price INTEGER NOT NULL,
      max_price INTEGER NOT NULL,
      sum_price INTEGER NOT NULL,
      sales     INTEGER NOT NULL,
      PRIMARY KEY (item_id, hour, is_clean)
    );
    CREATE INDEX IF NOT EXISTS idx_rollup_item ON price_rollup(item_id, hour DESC);

    -- Bazaar, written only when a price moves materially or on a heartbeat.
    CREATE TABLE IF NOT EXISTS bazaar_snapshot (
      item_id    TEXT    NOT NULL,
      ts         INTEGER NOT NULL,
      buy_price  REAL    NOT NULL,
      sell_price REAL    NOT NULL,
      PRIMARY KEY (item_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_bz_item ON bazaar_snapshot(item_id, ts DESC);

    -- Dedupe across restarts and prove we never skipped a window.
    CREATE TABLE IF NOT EXISTS seen_auctions (
      auction_id TEXT PRIMARY KEY,
      seen_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingest_log (
      ts        INTEGER PRIMARY KEY,
      kind      TEXT NOT NULL,
      returned  INTEGER,
      fresh     INTEGER,
      note      TEXT
    );
  `);

  return db;
}

export function makeStatements(db) {
  return {
    insertTracked: db.prepare(`
      INSERT OR IGNORE INTO tracked_sales
        (auction_id, seller, seller_profile, buyer, sold_at, price, bin,
         item_id, crafted_at, upgrades, item_bytes, ingested_at)
      VALUES (@auction_id, @seller, @seller_profile, @buyer, @sold_at, @price, @bin,
              @item_id, @crafted_at, @upgrades, @item_bytes, @ingested_at)
    `),

    upsertRollup: db.prepare(`
      INSERT INTO price_rollup (item_id, hour, is_clean, min_price, max_price, sum_price, sales)
      VALUES (@item_id, @hour, @is_clean, @price, @price, @price, 1)
      ON CONFLICT(item_id, hour, is_clean) DO UPDATE SET
        min_price = MIN(min_price, excluded.min_price),
        max_price = MAX(max_price, excluded.max_price),
        sum_price = sum_price + excluded.sum_price,
        sales     = sales + 1
    `),

    seen: db.prepare('INSERT OR IGNORE INTO seen_auctions (auction_id, seen_at) VALUES (?, ?)'),
    wasSeen: db.prepare('SELECT 1 FROM seen_auctions WHERE auction_id = ?'),
    pruneSeen: db.prepare('DELETE FROM seen_auctions WHERE seen_at < ?'),

    lastBazaar: db.prepare(
      'SELECT buy_price, sell_price FROM bazaar_snapshot WHERE item_id = ? ORDER BY ts DESC LIMIT 1',
    ),
    insertBazaar: db.prepare(
      'INSERT OR REPLACE INTO bazaar_snapshot (item_id, ts, buy_price, sell_price) VALUES (?, ?, ?, ?)',
    ),

    log: db.prepare(
      'INSERT OR REPLACE INTO ingest_log (ts, kind, returned, fresh, note) VALUES (?, ?, ?, ?, ?)',
    ),
  };
}
