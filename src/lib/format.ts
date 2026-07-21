/** Compact coin amount: 1_234_567 → "1.23M". Keeps the sign. */
export function coins(n: number, digits = 2): string {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v >= 1e9) return `${sign}${trim(v / 1e9, digits)}B`;
  if (v >= 1e6) return `${sign}${trim(v / 1e6, digits)}M`;
  if (v >= 1e3) return `${sign}${trim(v / 1e3, digits <= 1 ? digits : 1)}k`;
  return `${sign}${Math.round(v)}`;
}

/** Same as coins() but always shows a leading + for positives. */
export function signedCoins(n: number, digits = 2): string {
  return (n > 0 ? '+' : '') + coins(n, digits);
}

/** Full precision with thousands separators, for tooltips and detail rows. */
export function exactCoins(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Bazaar unit prices, which are genuinely fractional — plenty of products sell
 * for well under one coin. Rounding those to "0" makes the spread columns read
 * as nonsense, so keep decimals until the number is big enough not to need them.
 */
export function unitPrice(n: number): string {
  if (n < 10) return n.toFixed(2);
  if (n < 1000) return n.toFixed(1);
  return coins(n);
}

export function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 10_000) return `${Math.round(n).toLocaleString('en-US')}%`;
  return `${n.toFixed(digits)}%`;
}

export function signedPct(n: number, digits = 1): string {
  return (n > 0 ? '+' : '') + pct(n, digits);
}

function trim(v: number, digits: number): string {
  return v
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "3d 4h", "5h 12m", "42m" — how long an item was held or listed. */
export function duration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const SOURCE_LABEL: Record<string, string> = {
  own_snapshot: 'Archived price',
  coflnet: 'Backfilled price',
  live_fallback: 'Estimated from today',
};

export function priceSourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s;
}

export function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
