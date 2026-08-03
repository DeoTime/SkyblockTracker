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
 * So we keep three different shapes:
 *
 *   tracked_sales  full fidelity, raw NBT, our players SELLING (~20 rows/day)
 *   tracked_buys   full fidelity, raw NBT, our players BUYING  (~20 rows/day)
 *   price_rollup   per (item, hour, clean?) min/max/count for EVERYONE, no NBT
 *
 * The rollup is what makes historical cost basis possible; the raw rows are
 * what make a flip auditable. Neither alone is sufficient.
 *
 * Both tracked tables come out of the same ended-auctions feed, matched on
 * different fields — seller for one, buyer for the other. A tracked player
 * selling to another tracked player lands in both, which is correct: it is one
 * player's sale and another's purchase.
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

    -- The other side of the same feed: auctions a tracked player BOUGHT.
    --
    -- Until this existed, a purchase fell through to price_rollup like any
    -- stranger's sale and its NBT was discarded, so a resold item was costed at
    -- what it would cost to CRAFT rather than at what was actually paid for it.
    -- On a pure resell those are different numbers and only one of them is the
    -- cost basis.
    --
    -- item_uuid is the join key back to a later sale — the item's own identity,
    -- which survives the trade. Indexed because that lookup happens per flip.
    --
    -- item_bytes is kept for the same reason tracked_sales keeps it: the buy is
    -- half of an auditable flip, and an upgrade applied AFTER purchase can only
    -- be told apart from one that came with the item by comparing the two.
    -- source tells the two writers apart:
    --   hypixel  the live ended-auctions feed — has raw NBT, forward-only
    --   coflnet  backfilled from sky.coflnet.com — no raw NBT, reaches history
    -- upgrade_keys carries the Coflnet rows' upgrade fingerprint, which is the
    -- only thing standing in for the NBT they do not come with.
    CREATE TABLE IF NOT EXISTS tracked_buys (
      auction_id   TEXT PRIMARY KEY,
      buyer        TEXT NOT NULL,
      seller       TEXT,
      bought_at    INTEGER NOT NULL,
      price        INTEGER NOT NULL,
      bin          INTEGER NOT NULL,
      item_id      TEXT,
      item_uuid    TEXT,
      item_bytes   TEXT,
      source       TEXT,
      upgrade_keys TEXT,
      ingested_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_buys_item ON tracked_buys(item_uuid, bought_at DESC);
    CREATE INDEX IF NOT EXISTS idx_buys_buyer ON tracked_buys(buyer, bought_at DESC);

    -- Coflnet auctions already examined, WHETHER OR NOT they turned into a buy.
    -- Losing bids never produce a tracked_buys row, so without this the backfill
    -- would re-fetch every one of them on every pass forever. Deliberately not
    -- seen_auctions: that table is pruned after 6h to bound the dedupe set,
    -- whereas this has to remember indefinitely for the skip to hold.
    CREATE TABLE IF NOT EXISTS coflnet_checked (
      auction_id TEXT PRIMARY KEY,
      checked_at INTEGER NOT NULL,
      won        INTEGER NOT NULL
    );

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

    -- Underpriced live listings detected by the snipe scanner. The read API
    -- streams new rows (by ascending id) to the Minecraft mod. auction_id is
    -- UNIQUE so a listing still up next scan cannot alert twice.
    CREATE TABLE IF NOT EXISTS snipe_alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id  TEXT UNIQUE NOT NULL,
      item_id     TEXT NOT NULL,
      item_name   TEXT,
      price       INTEGER NOT NULL,
      baseline    INTEGER NOT NULL,
      est_resale  INTEGER NOT NULL,
      est_profit  INTEGER NOT NULL,
      margin_pct  REAL NOT NULL,
      seller      TEXT,
      ends_at     INTEGER,
      detected_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snipe_detected ON snipe_alerts(detected_at DESC);
  `);

  /**
   * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
   * columns added after a database is in the field need this. Duplicate-column
   * is the expected outcome on every run after the first and is not an error.
   */
  for (const [table, column, decl] of [
    ['tracked_buys', 'source', 'TEXT'],
    ['tracked_buys', 'upgrade_keys', 'TEXT'],
  ]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    } catch {
      /* already present */
    }
  }

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

    /**
     * INSERT OR IGNORE, so the live feed and the Coflnet backfill can both
     * claim the same auction without fighting. Whichever arrives first wins,
     * and the live feed is the one worth keeping: it carries raw NBT.
     */
    insertBuy: db.prepare(`
      INSERT OR IGNORE INTO tracked_buys
        (auction_id, buyer, seller, bought_at, price, bin,
         item_id, item_uuid, item_bytes, source, upgrade_keys, ingested_at)
      VALUES (@auction_id, @buyer, @seller, @bought_at, @price, @bin,
              @item_id, @item_uuid, @item_bytes, @source, @upgrade_keys, @ingested_at)
    `),

    /* Coflnet backfill bookkeeping. */
    markCoflChecked: db.prepare(
      'INSERT OR REPLACE INTO coflnet_checked (auction_id, checked_at, won) VALUES (?, ?, ?)',
    ),
    wasCoflChecked: db.prepare('SELECT 1 FROM coflnet_checked WHERE auction_id = ?'),
    countBuys: db.prepare('SELECT COUNT(*) AS n FROM tracked_buys'),

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
    pruneAlerts: db.prepare('DELETE FROM snipe_alerts WHERE detected_at < ?'),

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
