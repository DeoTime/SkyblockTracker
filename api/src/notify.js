/**
 * Discord sale notifications.
 *
 * A background watcher in server.js finds each newly-recorded tracked sale and
 * hands it here to build + POST a Discord embed: the item, the profit made, the
 * month-to-date cumulative profit, and a month-to-date graph.
 *
 * The graph is rendered by QuickChart (an external chart-image service) from a
 * config in the URL — only coin totals leave the box, no account identity — and
 * can be turned off with SALE_CHART=0, in which case the embed carries an inline
 * sparkline instead.
 */

/** Returns config, or null when the feature is off (no valid webhook). */
export function loadSaleNotifyConfig(env = process.env) {
  const url = env.SALE_WEBHOOK_URL ?? '';
  if (!/^https:\/\//i.test(url)) return null; // https-only, and unset == disabled
  return {
    url,
    intervalMs: Number(env.SALE_WEBHOOK_INTERVAL_MS) || 20_000,
    chart: env.SALE_CHART !== '0',
    chartBase: env.SALE_CHART_BASE ?? 'https://quickchart.io/chart',
  };
}

/** Compact coin formatting: 12_340_000 -> "12.34M". */
export function fmtCoins(n) {
  const s = n < 0 ? '-' : '';
  const a = Math.abs(Math.round(n));
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`;
  return `${s}${a}`;
}

/** Start of the current month in UTC (the container runs TZ=UTC). */
export function monthStartUtc(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Unicode sparkline of the cumulative-profit series — the no-egress fallback. */
export function sparkline(series) {
  const vals = series.map((p) => p.cumulative);
  if (vals.length === 0) return '—';
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return vals.map((v) => bars[Math.min(bars.length - 1, Math.floor(((v - min) / span) * (bars.length - 1)))]).join('');
}

/** QuickChart line-chart image URL for the MTD cumulative-profit series. */
export function quickChartUrl(base, series) {
  const config = {
    type: 'line',
    data: {
      labels: series.map((p) => p.date.slice(5)), // MM-DD
      datasets: [
        {
          label: 'Cumulative profit MTD',
          data: series.map((p) => p.cumulative),
          borderColor: '#3ba55d',
          backgroundColor: 'rgba(59,165,93,0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8a8f98', maxTicksLimit: 8 }, grid: { display: false } },
        y: { ticks: { color: '#8a8f98' }, grid: { color: 'rgba(255,255,255,0.06)' } },
      },
    },
  };
  return `${base}?w=520&h=260&devicePixelRatio=2&bkg=%230f1117&c=${encodeURIComponent(JSON.stringify(config))}`;
}

/**
 * Build the Discord webhook body for one sale.
 * @param flip  a FlipSummary from buildFlip (netProfit, salePrice, costBasis, …)
 * @param mtd   { total, count } — month-to-date across all tracked sellers
 * @param opts  { chartUrl?, series? }
 */
export function saleWebhookBody(flip, mtd, { chartUrl = null, series = null } = {}) {
  const pos = flip.netProfit >= 0;
  const fields = [
    { name: 'Sale price', value: fmtCoins(flip.salePrice), inline: true },
    { name: 'Profit', value: `${pos ? '+' : ''}${fmtCoins(flip.netProfit)} (${flip.profitPct}%)`, inline: true },
    { name: 'Cost basis', value: fmtCoins(flip.costBasis), inline: true },
    { name: `Profit month-to-date · ${mtd.count} flips`, value: `**${fmtCoins(mtd.total)}**`, inline: false },
  ];
  if (!chartUrl && series) {
    fields.push({ name: 'MTD', value: '`' + sparkline(series) + '`', inline: false });
  }

  const embed = {
    title: `${pos ? '🟢' : '🔴'} ${flip.itemName} sold`,
    color: pos ? 0x3ba55d : 0xed4245,
    fields,
    timestamp: flip.soldAt,
    footer: { text: `${flip.acquisition} · basis from ${flip.priceSource}` },
  };
  if (chartUrl) embed.image = { url: chartUrl };
  return { embeds: [embed] };
}

/** POST a webhook body. https + redirect:error is the SSRF guard; best-effort. */
export async function postWebhook(url, body) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
}
