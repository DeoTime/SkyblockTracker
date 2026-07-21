import { openDb } from './db.js';

// Quick health/size report: `docker compose exec ingest npm run stats`
const db = openDb(process.env.DB_PATH ?? '/data/skyblock.db');

const one = (sql) => db.prepare(sql).get();
const all = (sql, n = 10) => db.prepare(sql).all().slice(0, n);
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

const pageSize = db.pragma('page_size', { simple: true });
const pageCount = db.pragma('page_count', { simple: true });

console.log('=== database ===');
console.log(`size            ${mb(pageSize * pageCount)}`);

const tracked = one('SELECT COUNT(*) c, MIN(sold_at) lo, MAX(sold_at) hi FROM tracked_sales');
const rollup = one('SELECT COUNT(*) c, SUM(sales) s FROM price_rollup');
const bazaar = one('SELECT COUNT(*) c FROM bazaar_snapshot');
const logs = one("SELECT MIN(ts) lo, MAX(ts) hi FROM ingest_log WHERE kind='ended'");

console.log('\n=== coverage ===');
if (logs?.lo) {
  const hours = (logs.hi - logs.lo) / 3_600_000;
  console.log(`running for     ${hours.toFixed(1)} h`);

  // The first bazaar poll writes a full ~1,900-row baseline; every later poll
  // writes only what moved. Extrapolating across that one-off makes the daily
  // figure several times too high, so refuse to project until it has washed out.
  if (hours >= 2) {
    console.log(`projected/day   ${mb(((pageSize * pageCount) / hours) * 24)}`);
  } else {
    console.log('projected/day   (needs 2h+ — startup baseline skews it)');
  }
}

console.log('\n=== tracked sellers (full detail) ===');
console.log(`sales captured  ${tracked.c}`);
if (tracked.lo) {
  console.log(`first           ${new Date(tracked.lo).toISOString()}`);
  console.log(`latest          ${new Date(tracked.hi).toISOString()}`);
}

console.log('\n=== everyone else (price rollup only) ===');
console.log(`rollup rows     ${rollup.c}`);
console.log(`sales observed  ${rollup.s ?? 0}`);
console.log(`bazaar rows     ${bazaar.c}`);

console.log('\n=== recent tracked sales ===');
for (const r of all(
  'SELECT item_id, price, sold_at, seller FROM tracked_sales ORDER BY sold_at DESC',
)) {
  console.log(
    `  ${new Date(r.sold_at).toISOString().slice(0, 16)}  ${String(r.item_id).padEnd(28)} ${r.price.toLocaleString('en-US').padStart(14)}  ${r.seller.slice(0, 8)}`,
  );
}

const gaps = db
  .prepare("SELECT ts FROM ingest_log WHERE kind='ended' ORDER BY ts")
  .all()
  .map((r) => r.ts);
let worst = 0;
for (let i = 1; i < gaps.length; i++) worst = Math.max(worst, gaps[i] - gaps[i - 1]);
console.log('\n=== ingest continuity ===');
console.log(`polls logged    ${gaps.length}`);
console.log(`largest gap     ${(worst / 1000).toFixed(0)}s ${worst > 60_000 ? '  <-- WINDOW MISSED, data lost' : '(ok)'}`);

db.close();
