import { useState } from 'react';
import type { SalesCohort } from '../../api/types';
import { exactCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const M = { top: 16, right: 18, bottom: 30, left: 44 };

const SERIES = ['var(--series-1)', 'var(--series-2)'];

interface Props {
  cohorts: SalesCohort[];
  height?: number;
}

/**
 * Hourly sales count per cohort, as grouped bars.
 *
 * Bars rather than a line: this is a count of discrete events per hour, and a
 * connecting line would imply a continuous quantity that had values between
 * the buckets. Grouped rather than stacked, because the cohorts are mutually
 * exclusive alternatives being compared — stacking would invite reading the
 * total as meaningful when no sale is in both.
 *
 * A cohort with zero sales every hour still gets its legend entry and its slot
 * in each group. Dropping it would turn "nobody buys this combination" into
 * "we did not look", which is the more misleading of the two.
 *
 * A 7-day window is 168 buckets, so bars are hairlines and one label per bucket
 * is impossible: labels are thinned to a clock-aligned step and every UTC
 * midnight gets a separator, which is what keeps a dense series readable.
 */
export function SalesVolumeChart({ cohorts, height = 280 }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const points = cohorts[0]?.points ?? [];
  const n = points.length;
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;

  const peak = Math.max(1, ...cohorts.flatMap((c) => c.points.map((p) => p.sales)));
  const [yMax, ticks] = niceTicks(peak, 4);

  const y = (v: number) => M.top + innerH - (v / yMax) * innerH;
  const groupW = n ? innerW / n : 0;
  // Hairline-tolerant: at 168 buckets a group is a few pixels wide, so the
  // inter-bar gap has to shrink with it rather than eat the whole bar.
  const barW = cohorts.length ? Math.min(26, (groupW * 0.72) / cohorts.length) : 0;
  const gap = barW > 4 ? 2 : 0.4;

  const step = labelStep(n);
  const midnights = n > 48;

  const legend = (
    <div className="legend">
      {cohorts.map((c, i) => (
        <span className="legend-item" key={c.key}>
          <span className="swatch" style={{ background: SERIES[i % SERIES.length] }} />
          {c.label}
          <span className="muted">
            {' '}
            · {c.sales.toLocaleString('en-US')} sale{c.sales === 1 ? '' : 's'}
          </span>
        </span>
      ))}
    </div>
  );

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (innerW <= 0 || n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - M.left;
    const i = Math.floor(x / groupW);
    setHover(i >= 0 && i < n ? i : null);
  }

  return (
    <div>
      {legend}
      <div className="chart-wrap" ref={ref}>
        {width > 0 && (
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={cohorts
              .map((c) => `${c.label}: ${c.sales} sales over ${n} hours`)
              .join('. ')}
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
                  {t}
                </text>
              </g>
            ))}

            {hover !== null && (
              <rect
                x={M.left + hover * groupW}
                y={M.top}
                width={Math.max(groupW, 2)}
                height={innerH}
                fill="var(--ghost)"
                pointerEvents="none"
              />
            )}

            {points.map((p, i) => {
              const h = hourNum(p.hour);
              const groupMid = M.left + i * groupW + groupW / 2;
              const spread = barW * cohorts.length;
              const labelled = h % step === 0;
              return (
                <g key={p.hour}>
                  {midnights && h === 0 && (
                    <line
                      x1={M.left + i * groupW}
                      x2={M.left + i * groupW}
                      y1={M.top}
                      y2={M.top + innerH}
                      stroke="var(--gridline)"
                      strokeWidth={1}
                    />
                  )}
                  {cohorts.map((c, ci) => {
                    const pt = c.points[i];
                    const v = pt?.sales ?? 0;
                    const x = groupMid - spread / 2 + ci * barW;
                    return (
                      <rect
                        key={c.key}
                        x={x}
                        y={y(v)}
                        width={Math.max(0.8, barW - gap)}
                        height={Math.max(0, M.top + innerH - y(v))}
                        rx={barW > 4 ? 2 : 0}
                        fill={SERIES[ci % SERIES.length]}
                        /* The hour still filling is a fraction of a bar, not a
                           collapse in demand — draw it as provisional. */
                        opacity={pt?.partial ? 0.45 : 1}
                      />
                    );
                  })}
                  {labelled && (
                    <text
                      x={groupMid}
                      y={height - 10}
                      textAnchor="middle"
                      fontSize={11}
                      fill="var(--text-muted)"
                    >
                      {h === 0 ? p.hour.slice(5, 10) : `${p.hour.slice(11, 13)}:00`}
                    </text>
                  )}
                </g>
              );
            })}

            <line
              x1={M.left}
              x2={width - M.right}
              y1={M.top + innerH}
              y2={M.top + innerH}
              stroke="var(--baseline)"
              strokeWidth={1.5}
            />
          </svg>
        )}

        {hover !== null && points[hover] && (
          <div
            className="tooltip"
            style={{
              left: Math.min(
                Math.max(M.left + hover * groupW + groupW / 2 + 10, 8),
                Math.max(8, width - 240),
              ),
              top: M.top + 4,
            }}
          >
            <div className="tooltip-title">
              {label(points[hover].hour)}
              {points[hover].partial && <span className="muted"> · still filling</span>}
            </div>
            {cohorts.map((c, i) => {
              const pt = c.points[hover];
              return (
                <div className="tooltip-row" key={c.key}>
                  <span className="swatch" style={{ background: SERIES[i % SERIES.length] }} />
                  <span>
                    {c.label}: {pt?.sales ?? 0}
                    {pt?.medianPrice != null && (
                      <span className="muted"> · med {exactCoins(pt.medianPrice)}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const hourNum = (iso: string) => Number(iso.slice(11, 13));

/** "07-26 14:00 UTC" — the stamps are UTC, so the axis says so rather than
    quietly rendering in the reader's zone and shifting every bucket. */
const label = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 13)}:00 UTC`;

/**
 * Hours between x labels. Only divisors of 24 are used, so labels land on the
 * same clock times every day instead of drifting across the window.
 */
function labelStep(n: number): number {
  for (const s of [1, 2, 3, 4, 6, 12, 24]) if (n / s <= 9) return s;
  return 24;
}

/** Whole-number ticks — this axis counts sales, so 2.5 is not a value it can take. */
function niceTicks(peak: number, count: number): [number, number[]] {
  const raw = peak / count;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const norm = raw / mag;
  const step = Math.max(1, (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag);

  const hi = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= hi + step / 2; t += step) ticks.push(Math.round(t));
  return [hi || 1, ticks];
}
