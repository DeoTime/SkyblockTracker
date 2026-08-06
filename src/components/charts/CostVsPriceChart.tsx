import { useState } from 'react';
import type { ItemBuild } from '../../api/types';
import { coins, exactCoins, shortDate, signedCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const M = { top: 16, right: 66, bottom: 26, left: 60 };

const SERIES = ['var(--series-1)', 'var(--series-2)'];

interface Props {
  dates: string[];
  builds: ItemBuild[];
  height?: number;
}

/**
 * Sale price against craft cost, for several builds of the same item at once.
 *
 * Two encodings, deliberately on different channels: **hue is the build**, and
 * **line style is the question** — solid for what one sells for, dashed for
 * what one costs to make. So the pairing a reader has to see (this price
 * belongs to that cost) is carried by colour, and the shaded band between each
 * pair is the margin that build has to live inside.
 *
 * Every series is nullable and the gaps are load-bearing. The market side comes
 * from a 7-day feed and the cost side from our own ingest, which reaches
 * further back, so the left of the chart is routinely cost-only. Lines are
 * therefore drawn as segments across the days they actually have, never
 * interpolated over a hole — joining across a gap would draw a week of prices
 * nobody observed.
 *
 * One y-axis in coins for all four. A second axis would be a lie here.
 */
export function CostVsPriceChart({ dates, builds, height = 320 }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (dates.length === 0 || builds.length === 0) {
    return <div className="state">No price history for this item.</div>;
  }

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;

  const all = builds.flatMap((b) => b.points.flatMap((p) => [p.marketPrice, p.craftCost])).filter(isNum);
  if (all.length === 0) return <div className="state">Nothing in this window could be priced.</div>;

  const [yMin, yMax, ticks] = niceScale(Math.min(...all), Math.max(...all), 4);

  const x = (i: number) => M.left + (dates.length === 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const lastIdx = dates.length - 1;
  const xTickEvery = Math.max(1, Math.ceil(dates.length / 6));

  /** Right-edge labels for every series that reaches the right-hand side. */
  const endLabels = collide(
    builds.flatMap((b, bi) => {
      const out: { text: string; y: number; color: string }[] = [];
      const price = lastOf(b.points, (p) => p.marketPrice);
      const cost = lastOf(b.points, (p) => p.craftCost);
      if (price !== null) out.push({ text: 'price', y: y(price), color: SERIES[bi % SERIES.length] });
      if (cost !== null) out.push({ text: 'cost', y: y(cost), color: SERIES[bi % SERIES.length] });
      return out;
    }),
  );

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - M.left) / innerW));
    setHover(Math.round(frac * lastIdx));
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="legend">
        {builds.map((b, i) => (
          <span className="legend-item" key={b.key}>
            <span className="swatch" style={{ background: SERIES[i % SERIES.length] }} />
            {b.label}
            <span className="muted">
              {' '}
              · {b.salesMatched.toLocaleString('en-US')} sale{b.salesMatched === 1 ? '' : 's'}
            </span>
          </span>
        ))}
        <span className="legend-item muted">
          <svg width={22} height={9} aria-hidden="true">
            <line x1={0} x2={22} y1={4.5} y2={4.5} stroke="currentColor" strokeWidth={2} />
          </svg>
          sale price
        </span>
        <span className="legend-item muted">
          <svg width={22} height={9} aria-hidden="true">
            <line x1={0} x2={22} y1={4.5} y2={4.5} stroke="currentColor" strokeWidth={2} strokeDasharray="5 3" />
          </svg>
          craft cost
        </span>
      </div>

      <div className="chart-wrap" ref={ref}>
        {width > 0 && (
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={builds
              .map((b) =>
                b.latest
                  ? `${b.label}: sells for ${coins(b.latest.marketPrice)}, costs ${coins(b.latest.craftCost)} to build`
                  : `${b.label}: no day with both a price and a cost`,
              )
              .join('. ')}
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

            {builds.map((b, bi) => {
              const color = SERIES[bi % SERIES.length];
              const price = runs(b.points, (p) => p.marketPrice);
              const cost = runs(b.points, (p) => p.craftCost);
              // Shaded only where BOTH numbers exist — a margin needs two sides.
              const bands = runs(b.points, (p) => (isNum(p.marketPrice) && isNum(p.craftCost) ? 1 : null));

              return (
                <g key={b.key}>
                  {bands.map((run) => (
                    <path
                      key={`band-${run[0]}`}
                      d={
                        `M${run.map((i) => `${x(i)},${y(b.points[i].marketPrice as number)}`).join(' L')} ` +
                        `L${[...run].reverse().map((i) => `${x(i)},${y(b.points[i].craftCost as number)}`).join(' L')} Z`
                      }
                      fill={color}
                      fillOpacity={0.09}
                    />
                  ))}

                  {cost.map((run) => (
                    <Series key={`cost-${run[0]}`} run={run} x={x} y={y} values={b.points.map((p) => p.craftCost)} color={color} dashed />
                  ))}
                  {price.map((run) => (
                    <Series key={`price-${run[0]}`} run={run} x={x} y={y} values={b.points.map((p) => p.marketPrice)} color={color} />
                  ))}

                  {/* A day still filling is a median of a handful of sales, so
                      its point is drawn hollow rather than as a settled price. */}
                  {b.points.map((p, i) =>
                    p.partial && isNum(p.marketPrice) ? (
                      <circle
                        key={`partial-${p.date}`}
                        cx={x(i)}
                        cy={y(p.marketPrice)}
                        r={3.5}
                        fill="var(--surface-1)"
                        stroke={color}
                        strokeWidth={2}
                      />
                    ) : null,
                  )}
                </g>
              );
            })}

            {/* Direct labels, so which line is which never rests on the legend alone. */}
            {endLabels.map((l) => (
              <text key={`${l.text}-${l.y}`} x={width - M.right + 8} y={l.y} dominantBaseline="middle" fontSize={11.5} fill={l.color}>
                {l.text}
              </text>
            ))}

            {dates.map((d, i) =>
              i % xTickEvery === 0 || i === lastIdx ? (
                <text
                  key={d}
                  x={x(i)}
                  y={height - 8}
                  textAnchor={i === lastIdx ? 'end' : i === 0 ? 'start' : 'middle'}
                  fontSize={11}
                  fill="var(--text-muted)"
                >
                  {shortDate(d)}
                </text>
              ) : null,
            )}

            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
                {builds.map((b, bi) =>
                  [b.points[hover]?.marketPrice, b.points[hover]?.craftCost].map((v, k) =>
                    isNum(v) ? (
                      <circle
                        key={`${b.key}-${k}`}
                        cx={x(hover)}
                        cy={y(v)}
                        r={4.5}
                        fill={SERIES[bi % SERIES.length]}
                        stroke="var(--surface-1)"
                        strokeWidth={2}
                      />
                    ) : null,
                  ),
                )}
              </g>
            )}
          </svg>
        )}

        {hover !== null && (
          <div
            className="tooltip"
            style={{ left: Math.min(Math.max(x(hover) + 12, 8), Math.max(8, width - 260)), top: M.top + 4 }}
          >
            <div className="tooltip-title">
              {shortDate(dates[hover])}
              {builds.some((b) => b.points[hover]?.partial) && <span className="muted"> · today, still filling</span>}
            </div>
            {builds.map((b, bi) => {
              const p = b.points[hover];
              if (!p) return null;
              return (
                <div key={b.key} style={{ marginTop: bi === 0 ? 0 : 6 }}>
                  <div className="tooltip-row">
                    <span className="swatch" style={{ background: SERIES[bi % SERIES.length] }} />
                    <span>{b.label}</span>
                  </div>
                  <div className="tooltip-row muted">
                    <span className="swatch" style={{ background: 'transparent' }} />
                    <span>
                      {isNum(p.marketPrice) ? (
                        <>
                          Price {exactCoins(p.marketPrice)} <span className="muted">({p.sales} sold)</span>
                        </>
                      ) : (
                        'Price — no sales of this build'
                      )}
                    </span>
                  </div>
                  <div className="tooltip-row muted">
                    <span className="swatch" style={{ background: 'transparent' }} />
                    <span>
                      {isNum(p.craftCost) ? `Cost ${exactCoins(p.craftCost)}` : 'Cost — not priceable'}
                      {p.estimated && isNum(p.craftCost) ? ' (estimated)' : ''}
                    </span>
                  </div>
                  {isNum(p.marketPrice) && isNum(p.craftCost) && (
                    <div className="tooltip-row muted">
                      <span className="swatch" style={{ background: 'transparent' }} />
                      <span>Spread {signedCoins(p.marketPrice - p.craftCost)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One unbroken run of a series. A run of a single day has no line to draw and
 * would vanish; it gets a dot instead, because "one day was priced here" is a
 * different statement from "nothing was priced here".
 */
function Series({
  run,
  values,
  x,
  y,
  color,
  dashed = false,
}: {
  run: number[];
  values: (number | null)[];
  x: (i: number) => number;
  y: (v: number) => number;
  color: string;
  dashed?: boolean;
}) {
  if (run.length === 1) {
    return <circle cx={x(run[0])} cy={y(values[run[0]] as number)} r={2.5} fill={color} />;
  }
  return (
    <path
      d={run.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i)},${y(values[i] as number)}`).join(' ')}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinejoin="round"
      strokeDasharray={dashed ? '5 3' : undefined}
    />
  );
}

const isNum = (v: number | null | undefined): v is number => typeof v === 'number';

/** Index runs where `get` is non-null, so a gap breaks the line instead of spanning it. */
function runs<T>(points: T[], get: (p: T) => number | null): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  points.forEach((p, i) => {
    if (isNum(get(p))) current.push(i);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  });
  if (current.length) out.push(current);
  return out;
}

function lastOf<T>(points: T[], get: (p: T) => number | null): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = get(points[i]);
    if (isNum(v)) return v;
  }
  return null;
}

/**
 * Nudge right-edge labels apart. Four series on one axis routinely put two
 * within a few pixels of each other, and overlapping labels identify nothing.
 */
function collide<T extends { y: number }>(labels: T[], gap = 13): T[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i] = { ...sorted[i], y: sorted[i - 1].y + gap };
  }
  return sorted;
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
