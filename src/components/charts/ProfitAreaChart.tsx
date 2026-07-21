import { useState } from 'react';
import type { ProfitPoint } from '../../api/types';
import { coins, exactCoins, shortDate, signedCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const M = { top: 16, right: 18, bottom: 26, left: 60 };

interface Props {
  points: ProfitPoint[];
  height?: number;
}

/**
 * Cumulative net profit over the selected range. One series, so no legend —
 * the card title names it. Crosshair + tooltip on hover; the final value is
 * direct-labelled rather than labelling every point.
 */
export function ProfitAreaChart({ points, height = 260 }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <div className="state">No sales in this range yet.</div>;
  }

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;

  const values = points.map((p) => p.cumulative);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const [yMin, yMax, ticks] = niceScale(rawMin, rawMax, 4);

  const x = (i: number) =>
    M.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.cumulative)}`).join(' ');
  const zeroY = y(0);
  const areaPath = `${linePath} L${x(points.length - 1)},${zeroY} L${x(0)},${zeroY} Z`;

  const last = points[points.length - 1];
  const active = hover !== null ? points[hover] : null;

  // Show at most ~6 date ticks regardless of range length.
  const xTickEvery = Math.max(1, Math.ceil(points.length / 6));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - M.left;
    const frac = Math.min(1, Math.max(0, rel / innerW));
    setHover(Math.round(frac * (points.length - 1)));
  }

  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg
          className="chart-svg"
          width={width}
          height={height}
          role="img"
          aria-label={`Cumulative net profit, ending at ${exactCoins(last.cumulative)} coins`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={width - M.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--gridline)"
                strokeWidth={1}
              />
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
            <line
              x1={M.left}
              x2={width - M.right}
              y1={zeroY}
              y2={zeroY}
              stroke="var(--baseline)"
              strokeWidth={1.5}
            />
          )}

          <path d={areaPath} fill="var(--series-1)" fillOpacity={0.13} />
          <path
            d={linePath}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {points.map((p, i) =>
            i % xTickEvery === 0 || i === points.length - 1 ? (
              <text
                key={p.date}
                x={x(i)}
                y={height - 8}
                textAnchor={i === points.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
                fontSize={11}
                fill="var(--text-muted)"
              >
                {shortDate(p.date)}
              </text>
            ) : null,
          )}

          {/* Direct label on the final value, with a surface ring so it reads
              over the line it sits on. */}
          <circle
            cx={x(points.length - 1)}
            cy={y(last.cumulative)}
            r={4.5}
            fill="var(--series-1)"
            stroke="var(--surface-1)"
            strokeWidth={2}
          />

          {active && hover !== null && (
            <g pointerEvents="none">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={M.top}
                y2={M.top + innerH}
                stroke="var(--baseline)"
                strokeWidth={1}
              />
              <circle
                cx={x(hover)}
                cy={y(active.cumulative)}
                r={5}
                fill="var(--series-1)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      )}

      {active && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(x(hover) + 12, 8), Math.max(8, width - 190)),
            top: M.top + 4,
          }}
        >
          <div className="tooltip-title">{shortDate(active.date)}</div>
          <div className="tooltip-row">
            <span className="swatch" style={{ background: 'var(--series-1)' }} />
            <span>Total {exactCoins(active.cumulative)}</span>
          </div>
          <div className="tooltip-row" style={{ color: 'var(--text-secondary)' }}>
            <span className="swatch" style={{ background: 'transparent' }} />
            <span>Day {signedCoins(active.daily)}</span>
          </div>
        </div>
      )}
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
