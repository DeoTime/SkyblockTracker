import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FlipSummary } from '../api/types';
import {
  abbrevItem,
  coins,
  exactCoins,
  priceSourceLabel,
  signedCoins,
  signedPct,
  stampCompact,
  titleCase,
} from '../lib/format';

type SortKey = 'itemName' | 'soldAt' | 'costBasis' | 'salePrice' | 'ahFees' | 'netProfit' | 'profitPct';

interface Props {
  flips: FlipSummary[];
  showItemLink?: boolean;
}

/**
 * The tabular view of the same data the charts encode — this is what makes the
 * numbers readable without relying on color at all.
 */
export function FlipsTable({ flips, showItemLink = true }: Props) {
  const [sort, setSort] = useState<SortKey>('soldAt');
  const [desc, setDesc] = useState(true);

  if (flips.length === 0) return <div className="state">No flips recorded yet.</div>;

  const sorted = [...flips].sort((a, b) => {
    // Item is the one text column; the rest are numeric or a date.
    if (sort === 'itemName') {
      const c = a.itemName.localeCompare(b.itemName);
      return desc ? -c : c;
    }
    const av = sort === 'soldAt' ? +new Date(a.soldAt) : a[sort];
    const bv = sort === 'soldAt' ? +new Date(b.soldAt) : b[sort];
    return desc ? bv - av : av - bv;
  });

  function header(key: SortKey, label: string, align: 'left' | 'num' = 'num') {
    const active = sort === key;
    return (
      <th className={align === 'num' ? 'num' : undefined}>
        <button
          className="btn-ghost"
          style={{
            border: 0,
            padding: '2px 4px',
            font: 'inherit',
            color: active ? 'var(--text-primary)' : 'inherit',
            textTransform: 'inherit',
            letterSpacing: 'inherit',
          }}
          onClick={() => {
            if (active) setDesc((d) => !d);
            else {
              setSort(key);
              setDesc(true);
            }
          }}
          aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
        >
          {label}
          {active ? (desc ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {header('itemName', 'Item', 'left')}
            {header('soldAt', 'Sold')}
            {header('costBasis', 'Cost basis')}
            {header('salePrice', 'Sale')}
            {header('ahFees', 'Fees')}
            {header('netProfit', 'Net')}
            {header('profitPct', 'Margin')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr key={f.auctionUuid}>
              <td>
                <div className="item-cell">
                  <Link to={`/flip/${f.auctionUuid}`} className="link" title={f.itemName}>
                    {abbrevItem(f.itemName)}
                  </Link>
                  {showItemLink && (
                    <Link to={`/item/${f.itemId}`} className="pill" title="Price history for this item">
                      {titleCase(f.rarity)}
                    </Link>
                  )}
                  {f.priceSource !== 'own_snapshot' && (
                    <span className="pill" title={priceSourceLabel(f.priceSource)}>
                      ~
                    </span>
                  )}
                </div>
              </td>
              <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                {stampCompact(f.soldAt)}
              </td>
              <td
                className="num"
                title={`${exactCoins(f.baseItemCost)} base item (${f.acquisition}) + ${exactCoins(f.upgradeCost)} upgrades`}
              >
                {coins(f.costBasis)}
                {f.unpricedUpgrades > 0 && (
                  <span className="muted" title={`${f.unpricedUpgrades} upgrade(s) could not be priced`}>
                    {' '}
                    +?
                  </span>
                )}
              </td>
              <td className="num">{coins(f.salePrice)}</td>
              <td className="num muted">{coins(f.ahFees)}</td>
              <td className="num" style={{ fontWeight: 600, color: f.netProfit >= 0 ? 'var(--good-text)' : 'var(--critical)' }}>
                {signedCoins(f.netProfit)}
              </td>
              <td className="num muted">{signedPct(f.profitPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
