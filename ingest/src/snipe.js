import { decodeItem } from './decode.js';
import { createHmac } from 'node:crypto';

/**
 * Underpriced-listing ("snipe") detector.
 *
 * Scans the live Auction House for a small watchlist and records listings
 * priced well below the item's normal floor into snipe_alerts, which the read
 * API streams to the Minecraft mod. Optional outbound webhook (Discord / relay)
 * fires on each new alert.
 *
 * Everything here is KEYLESS — /skyblock/auctions needs no API key — so this
 * never depends on the stored Hypixel key.
 *
 * NOTE ON MEMORY: unlike a naive full-AH load, this holds only the matched
 * listings (a handful), discarding each page after filtering. Peak footprint is
 * one page, so it stays well inside the container limit.
 */

const API = 'https://api.hypixel.net/v2';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** `ETHERWARP_MERGER=Etherwarp Merger,SOME_ID=Display` -> [{id, name, match}] */
function parseWatch(s) {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const id = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      const name = (eq === -1 ? id.replace(/_/g, ' ') : pair.slice(eq + 1)).trim();
      return { id, name, match: name.toLowerCase() };
    })
    .filter((w) => w.id);
}

/** Returns config, or null when the feature is off (the safe default). */
export function loadSnipeConfig(env = process.env) {
  const on = env.SNIPE_ENABLED === '1' || (env.SNIPE_ENABLED ?? '').toLowerCase() === 'true';
  if (!on) return null;

  const watch = parseWatch(env.SNIPE_WATCH ?? 'ETHERWARP_MERGER=Etherwarp Merger');
  if (watch.length === 0) return null;

  return {
    watch,
    intervalMs: num(env.SNIPE_INTERVAL_MS, 15_000),
    dropThreshold: num(env.SNIPE_DROP_THRESHOLD, 0.35), // list price <= baseline*(1-this)
    minProfit: num(env.SNIPE_MIN_PROFIT, 2_000_000),
    minMarginPct: num(env.SNIPE_MIN_MARGIN_PCT, 25),
    minSample: num(env.SNIPE_MIN_SAMPLE, 5), // min rollup hours before we trust a baseline
    baselineHours: num(env.SNIPE_BASELINE_HOURS, 48),
    maxPages: num(env.SNIPE_MAX_PAGES, 0), // 0 = all pages
    webhookUrl: env.SNIPE_WEBHOOK_URL ?? '',
    webhookSecret: env.SNIPE_WEBHOOK_SECRET ?? '',
    dryRun: env.SNIPE_DRY_RUN === '1',
  };
}

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false) throw new Error(`${path} -> success:false`);
  return body;
}

/** Hypixel AH fee on a sale of `price`: 1% claim tax + tiered listing fee. */
function feeRateFor(price) {
  const listing = price >= 100_000_000 ? 0.025 : price >= 10_000_000 ? 0.02 : 0.01;
  return 0.01 + listing;
}

function displayName(id) {
  return id.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function toPayload(row) {
  return {
    type: 'snipe',
    item: { id: row.item_id, name: row.item_name ?? displayName(row.item_id) },
    auctionId: row.auction_id,
    price: row.price,
    baseline: row.baseline,
    estResale: row.est_resale,
    estProfit: row.est_profit,
    estMarginPct: row.margin_pct,
    seller: row.seller,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    detectedAt: new Date(row.detected_at).toISOString(),
    viewCommand: `/viewauction ${row.auction_id}`,
  };
}

export function makeSnipe(db, log, cfg) {
  const insertAlert = db.prepare(`
    INSERT OR IGNORE INTO snipe_alerts
      (auction_id, item_id, item_name, price, baseline, est_resale, est_profit,
       margin_pct, seller, ends_at, detected_at)
    VALUES (@auction_id, @item_id, @item_name, @price, @baseline, @est_resale, @est_profit,
            @margin_pct, @seller, @ends_at, @detected_at)
  `);
  const rollupHours = db.prepare(`
    SELECT min_price FROM price_rollup
     WHERE item_id = ? AND is_clean = 1 AND hour >= ?
     ORDER BY hour DESC
  `);

  const watchById = new Map(cfg.watch.map((w) => [w.id, w]));
  let lastUpdated = 0;

  function collectMatches(auctions, byItem) {
    for (const a of auctions) {
      if (!a.bin) continue; // MVP: only instantly-buyable listings
      const name = (a.item_name ?? '').toLowerCase();
      for (const w of cfg.watch) {
        if (name.includes(w.match)) {
          const arr = byItem.get(w.id) ?? [];
          arr.push({
            uuid: a.uuid,
            price: Number(a.starting_bid ?? 0),
            seller: a.auctioneer ?? null,
            end: a.end ?? null,
            itemName: a.item_name ?? null,
            item_bytes: a.item_bytes,
          });
          byItem.set(w.id, arr);
          break;
        }
      }
    }
  }

  function medianBaseline(id, now) {
    const fromHour = Math.floor(now / 3_600_000) - cfg.baselineHours;
    const rows = rollupHours.all(id, fromHour);
    if (rows.length < cfg.minSample) return null; // too little history to call anything "low"
    const vals = rows.map((r) => r.min_price).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  }

  async function evaluateItem(id, listings, now) {
    // The item id lives in the NBT, not the envelope — confirm it (name match can
    // catch a look-alike) and keep only clean base copies.
    const confirmed = [];
    for (const l of listings) {
      try {
        const d = await decodeItem(l.item_bytes);
        if (d && d.itemId === id && d.isClean) confirmed.push(l);
      } catch {
        /* undecodable blob — skip */
      }
    }
    if (confirmed.length === 0) return 0;

    confirmed.sort((a, b) => a.price - b.price);
    const baseline = medianBaseline(id, now);
    if (baseline === null) return 0;

    let fired = 0;
    for (const l of confirmed) {
      if (l.price > baseline * (1 - cfg.dropThreshold)) continue; // not "much lower than usual"

      // Resale = the cheapest OTHER live listing (what you'd relist just under);
      // if this is the only one, fall back to the historical baseline.
      const other = confirmed.find((x) => x.uuid !== l.uuid);
      const resale = other ? other.price : baseline;

      const estProfit = Math.round(resale * (1 - feeRateFor(resale)) - l.price);
      const marginPct = l.price > 0 ? +((estProfit / l.price) * 100).toFixed(1) : 0;
      if (estProfit < cfg.minProfit || marginPct < cfg.minMarginPct) continue;

      const row = {
        auction_id: l.uuid,
        item_id: id,
        item_name: l.itemName ?? watchById.get(id)?.name ?? displayName(id),
        price: l.price,
        baseline,
        est_resale: resale,
        est_profit: estProfit,
        margin_pct: marginPct,
        seller: l.seller,
        ends_at: Number(l.end ?? 0) || null,
        detected_at: now,
      };

      if (cfg.dryRun) {
        log(`snipe[dry]: ${id} @ ${l.price.toLocaleString('en-US')} ~${estProfit.toLocaleString('en-US')} (${marginPct}%)`);
        continue;
      }

      // INSERT OR IGNORE on the unique auction_id is the durable dedupe: a
      // listing that is still up next cycle produces changes:0 and never
      // re-alerts or re-fires the webhook.
      if (insertAlert.run(row).changes > 0) {
        fired++;
        log(`snipe: ${id} @ ${l.price.toLocaleString('en-US')} ~${estProfit.toLocaleString('en-US')} profit (${marginPct}%) ${l.uuid}`);
        fireWebhook(row).catch(() => {});
      }
    }
    return fired;
  }

  async function fireWebhook(row) {
    if (!cfg.webhookUrl || !/^https:\/\//i.test(cfg.webhookUrl)) return; // https only (SSRF guard)
    const payload = JSON.stringify(toPayload(row));
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.webhookSecret) {
      headers['X-Snipe-Signature'] =
        'sha256=' + createHmac('sha256', cfg.webhookSecret).update(payload).digest('hex');
    }
    try {
      await fetch(cfg.webhookUrl, { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(8000) });
    } catch {
      /* webhook is best-effort; the DB row is the source of truth */
    }
  }

  async function pollSnipe() {
    const first = await getJson('/skyblock/auctions?page=0');
    if (typeof first?.lastUpdated !== 'number') return;
    if (first.lastUpdated === lastUpdated) return; // AH set unchanged since last scan
    lastUpdated = first.lastUpdated;

    const totalPages = first.totalPages ?? 1;
    const pages = cfg.maxPages > 0 ? Math.min(totalPages, cfg.maxPages) : totalPages;

    const byItem = new Map();
    collectMatches(first.auctions ?? [], byItem);
    for (let p = 1; p < pages; p++) {
      try {
        const body = await getJson(`/skyblock/auctions?page=${p}`);
        if (body?.auctions) collectMatches(body.auctions, byItem);
      } catch {
        /* one flaky page shouldn't abort the whole scan — next cycle recovers */
      }
    }

    const now = Date.now();
    let fired = 0;
    for (const [id, listings] of byItem) {
      fired += await evaluateItem(id, listings, now);
    }
    if (fired) log(`snipe: ${fired} new alert(s) across ${byItem.size} watched item(s)`);
  }

  return pollSnipe;
}
