import { useMemo, useState } from 'react';
import type { FlipSummary } from '../../api/types';
import { coins, exactCoins, fullDate, signedCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const M = { top: 16, right: 18, bottom: 26, left: 60 };
const HOUR = 3_600_000;

/**
 * Windows the chart shows on demand. These run finer than the page-level range
 * filter (days) because a sub-day view answers a different question — "how did
 * the last few hours go" — and needs real timestamps, not daily buckets.
 */
const WINDOWS = [
  { key: '7d', label: '7d', ms: 7 * 24 * HOUR },
  { key: '72h', label: '72h', ms: 72 * HOUR },
  { key: '24h', label: '24h', ms: 24 * HOUR },
  { key: '12h', label: '12h', ms: 12 * HOUR },
  { key: '6h', label: '6h', ms: 6 * HOUR },
] as const;

type WindowKey = (typeof WINDOWS)[number]['key'];

interface Props {
  /** Every flip the dashboard loaded — the chart windows this itself. */
  flips: FlipSummary[];
  height?: number;
}

interface Pt {
  t: number;
  cum: number;
  profit: number;
  name: string;
  uuid: string;
}

/**
 * Cumulative net profit over a self-selected window. One series, so no legend —
 * the card title names it. A step line, because realised profit is flat between
 * sales and jumps at each one; a smooth curve would imply gains that never
 * happened. Crosshair + tooltip on hover.
 *
 * Windows anchor to the most recent sale, not to wall-clock now: with sparse
 * sales a strict "last 6 hours from now" is usually empty, which reads as broken
 * rather than as "nothing sold." Anchoring to the latest sale keeps every window
 * meaningful — it's "the last 6h of trading," through the most recent flip.
 */
export function ProfitAreaChart({ flips, height = 260 }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [win, setWin] = useState<WindowKey>('7d');
  const [hover, setHover] = useState<number | null>(null);

  const windowMs = WINDOWS.find((w) => w.key === win)!.ms;

  const { pts, cutoff, anchor } = useMemo(() => {
    const sorted = flips
      .map((f) => ({ f, t: new Date(f.soldAt).getTime() }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);

    const end = sorted.length ? sorted[sorted.length - 1].t : Date.now();
    const start = end - windowMs;

    let cum = 0;
    const points: Pt[] = [];
    for (const { f, t } of sorted) {
      if (t < start) continue;
      cum += f.netProfit;
      points.push({ t, cum, profit: f.netProfit, name: f.itemName, uuid: f.auctionUuid });
    }
    return { pts: points, cutoff: start, anchor: end };
  }, [flips, windowMs]);

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;

  const active = hover !== null ? pts[hover] : null;

  const header = (
    <div className="card-head">
      <h2>Cumulative net profit</h2>
      <div className="seg seg-sm" role="group" aria-label="Chart window">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            aria-pressed={win === w.key}
            onClick={() => {
              setWin(w.key);
              setHover(null);
            }}
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (pts.length === 0) {
    return (
      <div>
        {header}
        <div className="state">No sales in the last {WINDOWS.find((w) => w.key === win)!.label}.</div>
      </div>
    );
  }

  const cums = pts.map((p) => p.cum);
  const [yMin, yMax, ticks] = niceScale(Math.min(0, ...cums), Math.max(0, ...cums), 4);

  const span = anchor - cutoff || 1;
  const xt = (t: number) => M.left + ((t - cutoff) / span) * innerW;
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const zeroY = y(0);

  // Step path: flat between sales, vertical jump at each sale.
  let line = `M${xt(cutoff)},${y(0)}`;
  let prev = 0;
  for (const p of pts) {
    line += ` L${xt(p.t)},${y(prev)} L${xt(p.t)},${y(p.cum)}`;
    prev = p.cum;
  }
  line += ` L${xt(anchor)},${y(prev)}`;
  const areaPath = `${line} L${xt(anchor)},${zeroY} L${xt(cutoff)},${zeroY} Z`;

  const last = pts[pts.length - 1];

  const TICKS = 5;
  const tickTs = Array.from({ length: TICKS + 1 }, (_, i) => cutoff + (i / TICKS) * span);
  const fmtTick = (t: number) => {
    const d = new Date(t);
    return windowMs <= 24 * HOUR
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
  };

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = cutoff + Math.min(1, Math.max(0, (e.clientX - rect.left - M.left) / innerW)) * span;
    // Nearest sale to the cursor.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  }

  return (
    <div>
      {header}
      <div className="chart-wrap" ref={ref}>
        {width > 0 && (
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={`Cumulative net profit over the last ${
              WINDOWS.find((w) => w.key === win)!.label
            }, ending at ${exactCoins(last.cum)} coins`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--gridline)" strokeWidth={1} />
                <text
                  x={M.left - 10}
                  y={y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={11}
                  fill="var(--text-muted)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {coins(t, 1)}
                </text>
              </g>
            ))}

            {yMin < 0 && (
              <line x1={M.left} x2={width - M.right} y1={zeroY} y2={zeroY} stroke="var(--baseline)" strokeWidth={1.5} />
            )}

            <path d={areaPath} fill="var(--series-1)" fillOpacity={0.13} />
            <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {tickTs.map((t, i) => (
              <text
                key={t}
                x={xt(t)}
                y={height - 8}
                textAnchor={i === TICKS ? 'end' : i === 0 ? 'start' : 'middle'}
                fontSize={11}
                fill="var(--text-muted)"
              >
                {fmtTick(t)}
              </text>
            ))}

            {/* Direct label on the final value, ringed so it reads over the line. */}
            <circle cx={xt(anchor)} cy={y(last.cum)} r={4.5} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />

            {active && hover !== null && (
              <g pointerEvents="none">
                <line x1={xt(active.t)} x2={xt(active.t)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
                <circle cx={xt(active.t)} cy={y(active.cum)} r={5} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
              </g>
            )}
          </svg>
        )}

        {active && hover !== null && (
          <div
            className="tooltip"
            style={{
              left: Math.min(Math.max(xt(active.t) + 12, 8), Math.max(8, width - 210)),
              top: M.top + 4,
            }}
          >
            <div className="tooltip-title">{active.name}</div>
            <div className="tooltip-row" style={{ color: 'var(--text-secondary)' }}>
              <span className="swatch" style={{ background: 'transparent' }} />
              <span>{fullDate(new Date(active.t).toISOString())}</span>
            </div>
            <div className="tooltip-row">
              <span className="swatch" style={{ background: 'var(--series-1)' }} />
              <span>Total {exactCoins(active.cum)}</span>
            </div>
            <div className="tooltip-row" style={{ color: 'var(--text-secondary)' }}>
              <span className="swatch" style={{ background: 'transparent' }} />
              <span>This flip {signedCoins(active.profit)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Rounds a domain out to human tick values and returns [min, max, ticks]. */
function niceScale(min: number, max: number, count: number): [number, number, number[]] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;

  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t));
  return [lo, hi, ticks];
}
