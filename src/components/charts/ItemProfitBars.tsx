import { useState } from 'react';
import type { ItemAggregate } from '../../api/types';
import { abbrevItem, exactCoins, pct, signedCoins } from '../../lib/format';
import { useMeasure } from '../../lib/useMeasure';

const ROW = 30;
const GAP = 4; // ≥2px surface gap between adjacent fills
const LABEL_W = 168;
const VALUE_W = 74;
const TOP = 4;

interface Props {
  items: ItemAggregate[];
  onSelect?: (itemId: string) => void;
}

/**
 * Net profit per crafted item. Profit and loss are opposite polarities, so this
 * is a diverging encoding anchored at zero — blue/red rather than the classic
 * green/red, which is the red-green CVD failure case. Every bar also carries a
 * signed value label, so the sign never depends on color alone.
 */
export function ItemProfitBars({ items, onSelect }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (items.length === 0) {
    return <div className="state">No items to compare yet.</div>;
  }

  const height = TOP * 2 + items.length * (ROW + GAP);
  const plotL = LABEL_W;
  const plotW = Math.max(0, width - LABEL_W - VALUE_W);

  const maxAbs = Math.max(...items.map((i) => Math.abs(i.netProfit))) || 1;
  const hasLoss = items.some((i) => i.netProfit < 0);
  // With losses present the axis is symmetric around zero; otherwise zero sits
  // at the left edge and the full width encodes magnitude.
  const zeroX = hasLoss ? plotL + plotW / 2 : plotL;
  const scale = hasLoss ? plotW / 2 / maxAbs : plotW / maxAbs;

  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg className="chart-svg" width={width} height={height} role="img" aria-label="Net profit by item">
          <line
            x1={zeroX}
            x2={zeroX}
            y1={TOP}
            y2={height - TOP}
            stroke="var(--baseline)"
            strokeWidth={1}
          />

          {items.map((item, i) => {
            const y = TOP + i * (ROW + GAP);
            const end = zeroX + item.netProfit * scale;
            const positive = item.netProfit >= 0;
            const color = positive ? 'var(--pos)' : 'var(--neg)';
            const isHover = hover === i;

            return (
              <g
                key={item.itemId}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onClick={() => onSelect?.(item.itemId)}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
              >
                {/* Full-row hit target, larger than the mark itself. */}
                <rect
                  x={0}
                  y={y - GAP / 2}
                  width={width}
                  height={ROW + GAP}
                  fill={isHover ? 'var(--ghost)' : 'transparent'}
                />

                <text
                  x={0}
                  y={y + ROW / 2}
                  dominantBaseline="middle"
                  fontSize={12.5}
                  fill="var(--text-primary)"
                >
                  {truncate(abbrevItem(item.itemName), 22)}
                  <title>{item.itemName}</title>
                </text>

                <path d={barPath(zeroX, end, y + 5, ROW - 10, 4)} fill={color} />

                <text
                  x={width - VALUE_W + 8}
                  y={y + ROW / 2}
                  dominantBaseline="middle"
                  fontSize={12}
                  fill="var(--text-secondary)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {signedCoins(item.netProfit, 1)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {hover !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(LABEL_W, Math.max(8, width - 210)),
            top: TOP + hover * (ROW + GAP) + ROW + 6,
          }}
        >
          <div className="tooltip-title">{items[hover].itemName}</div>
          <div className="tooltip-row">
            <span
              className="swatch"
              style={{ background: items[hover].netProfit >= 0 ? 'var(--pos)' : 'var(--neg)' }}
            />
            <span>{signedCoins(items[hover].netProfit)} net</span>
          </div>
          <div className="tooltip-row muted">
            {items[hover].flips} flips · {pct(items[hover].avgMarginPct)} avg margin
          </div>
          <div className="tooltip-row muted">{exactCoins(items[hover].revenue)} revenue</div>
        </div>
      )}
    </div>
  );
}

/** Bar anchored at the zero baseline, rounded only on the value end. */
function barPath(x0: number, x1: number, y: number, h: number, r: number): string {
  const w = Math.abs(x1 - x0);
  const rr = Math.max(0, Math.min(r, w));
  if (w < 0.5) return `M${x0},${y} h1 v${h} h-1 Z`;

  if (x1 >= x0) {
    return `M${x0},${y} H${x1 - rr} Q${x1},${y} ${x1},${y + rr} V${y + h - rr} Q${x1},${y + h} ${x1 - rr},${y + h} H${x0} Z`;
  }
  return `M${x0},${y} H${x1 + rr} Q${x1},${y} ${x1},${y + rr} V${y + h - rr} Q${x1},${y + h} ${x1 + rr},${y + h} H${x0} Z`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
