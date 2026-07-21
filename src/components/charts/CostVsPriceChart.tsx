import { useState } from 'react';
import type { ItemHistoryPoint } from '../../api/types';
import { coins, exactCoins, shortDate, signedCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const M = { top: 16, right: 96, bottom: 26, left: 60 };

interface Props {
  points: ItemHistoryPoint[];
  height?: number;
}

/**
 * Craft cost vs market price for one item. Two series that must be told apart,
 * so this is categorical (slots 1 and 2) with a legend AND direct labels — the
 * band between them is the margin the flip depends on.
 *
 * Both series share one y-axis, in coins. A second axis would be a lie here.
 */
export function CostVsPriceChart({ points, height = 300 }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) return <div className="state">No price history for this item.</div>;

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;

  const all = points.flatMap((p) => [p.craftCost, p.marketPrice]);
  const [yMin, yMax, ticks] = niceScale(Math.min(...all), Math.max(...all), 4);

  const x = (i: number) => M.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const costPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.craftCost)}`).join(' ');
  const pricePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.marketPrice)}`).join(' ');
  const band = `${pricePath} L${x(points.length - 1)},${y(points[points.length - 1].craftCost)} ${points
    .slice()
    .reverse()
    .map((p, k) => `L${x(points.length - 1 - k)},${y(p.craftCost)}`)
    .join(' ')} Z`;

  const active = hover !== null ? points[hover] : null;
  const lastIdx = points.length - 1;
  const xTickEvery = Math.max(1, Math.ceil(points.length / 6));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - M.left) / innerW));
    setHover(Math.round(frac * lastIdx));
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: 'var(--series-2)' }} /> Market price
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> Craft cost
        </span>
      </div>

      <div className="chart-wrap" ref={ref}>
        {width > 0 && (
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label="Craft cost versus market price over time"
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

            <path d={band} fill="var(--text-muted)" fillOpacity={0.1} />

            <path d={costPath} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
            <path d={pricePath} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" />

            {/* Direct labels at the right end, so identity never rests on the legend alone. */}
            <text x={width - M.right + 8} y={y(points[lastIdx].marketPrice)} dominantBaseline="middle" fontSize={11.5} fill="var(--text-secondary)">
              Price
            </text>
            <text x={width - M.right + 8} y={y(points[lastIdx].craftCost)} dominantBaseline="middle" fontSize={11.5} fill="var(--text-secondary)">
              Cost
            </text>

            {points.map((p, i) =>
              i % xTickEvery === 0 || i === lastIdx ? (
                <text
                  key={p.date}
                  x={x(i)}
                  y={height - 8}
                  textAnchor={i === lastIdx ? 'end' : i === 0 ? 'start' : 'middle'}
                  fontSize={11}
                  fill="var(--text-muted)"
                >
                  {shortDate(p.date)}
                </text>
              ) : null,
            )}

            {active && hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
                <circle cx={x(hover)} cy={y(active.marketPrice)} r={5} fill="var(--series-2)" stroke="var(--surface-1)" strokeWidth={2} />
                <circle cx={x(hover)} cy={y(active.craftCost)} r={5} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
              </g>
            )}
          </svg>
        )}

        {active && hover !== null && (
          <div
            className="tooltip"
            style={{ left: Math.min(Math.max(x(hover) + 12, 8), Math.max(8, width - 200)), top: M.top + 4 }}
          >
            <div className="tooltip-title">{shortDate(active.date)}</div>
            <div className="tooltip-row">
              <span className="swatch" style={{ background: 'var(--series-2)' }} />
              <span>Price {exactCoins(active.marketPrice)}</span>
            </div>
            <div className="tooltip-row">
              <span className="swatch" style={{ background: 'var(--series-1)' }} />
              <span>Cost {exactCoins(active.craftCost)}</span>
            </div>
            <div className="tooltip-row muted">
              <span className="swatch" style={{ background: 'transparent' }} />
              <span>Spread {signedCoins(active.marketPrice - active.craftCost)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
