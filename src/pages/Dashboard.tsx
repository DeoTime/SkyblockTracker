import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import type { RangeKey } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { coins, exactCoins, pct, signedCoins } from '../lib/format';
import { ErrorState, Loading } from '../components/Layout';
import { HeroFigure, StatTile } from '../components/Stat';
import { Sparkline } from '../components/Sparkline';
import { FlipsTable } from '../components/FlipsTable';
import { ProfitAreaChart } from '../components/charts/ProfitAreaChart';
import { ItemProfitBars } from '../components/charts/ItemProfitBars';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All' },
];

export function Dashboard() {
  const { username = '' } = useParams();
  const [range, setRange] = useState<RangeKey>('30d');
  const navigate = useNavigate();

  const { data, error, loading } = useAsync(() => fetchDashboard(username, range), [username, range]);

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{username}</h1>
          <p className="sub">Craft-flip performance on the Auction House</p>
        </div>

        {/* Filters sit in one row above the charts. */}
        <div className="filters">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <Loading />}
      {error && <ErrorState error={error} />}

      {data && !loading && (
        <div className="stack">
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
              <HeroFigure
                label={`Net profit · last ${range === 'all' ? 'all time' : range}`}
                value={signedCoins(data.stats.netProfit)}
                note={
                  <>
                    {exactCoins(data.stats.grossRevenue)} revenue −{' '}
                    {exactCoins(data.stats.totalBaseItemCost)} base items −{' '}
                    {exactCoins(data.stats.totalUpgradeCost)} upgrades −{' '}
                    {exactCoins(data.stats.totalFees)} fees
                  </>
                }
              />
              <Sparkline
                values={data.profitSeries.map((p) => p.cumulative)}
                width={150}
                height={40}
                color={data.stats.netProfit >= 0 ? 'var(--pos)' : 'var(--neg)'}
              />
            </div>
          </div>

          <div className="grid grid-kpi">
            <StatTile label="Flips sold" value={String(data.stats.flipCount)} note={`${coins(data.stats.grossRevenue)} gross revenue`} />
            <StatTile
              label="Win rate"
              value={pct(data.stats.winRatePct, 0)}
              note="share of flips that cleared their cost basis"
            />
            <StatTile
              label="Avg margin"
              value={pct(data.stats.avgMarginPct)}
              note="net profit ÷ cost basis, per flip"
            />
            <StatTile
              label="Coins / hour"
              value={coins(data.stats.coinsPerHour)}
              note="net profit ÷ total craft-to-sale hold time"
            />
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Cumulative net profit</h2>
                <p className="sub">Running total of realised profit, after AH fees.</p>
              </div>
              <span className="card-note">
                {pct(data.stats.confidencePct, 0)} priced from archived snapshots
              </span>
            </div>
            <ProfitAreaChart points={data.profitSeries} />
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Net profit by item</h2>
                  <p className="sub">Which crafts actually carried the range.</p>
                </div>
              </div>
              <ItemProfitBars items={data.byItem} onSelect={(id) => navigate(`/item/${id}`)} />
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Best single flip</h2>
                  <p className="sub">Largest net profit in this range.</p>
                </div>
              </div>
              {data.stats.bestFlip ? (
                <div className="stack" style={{ gap: 12 }}>
                  <HeroFigure
                    label={data.stats.bestFlip.itemName}
                    value={signedCoins(data.stats.bestFlip.netProfit)}
                    note={`${pct(data.stats.bestFlip.profitPct)} margin`}
                  />
                  <div>
                    <div className="breakdown-row">
                      <span className="breakdown-name">Cost basis</span>
                      <span className="breakdown-val">{exactCoins(data.stats.bestFlip.costBasis)}</span>
                    </div>
                    <div className="breakdown-row">
                      <span className="breakdown-name">Sale price</span>
                      <span className="breakdown-val">{exactCoins(data.stats.bestFlip.salePrice)}</span>
                    </div>
                    <div className="breakdown-row">
                      <span className="breakdown-name">AH fees</span>
                      <span className="breakdown-val">−{exactCoins(data.stats.bestFlip.ahFees)}</span>
                    </div>
                  </div>
                  <Link className="link" to={`/flip/${data.stats.bestFlip.auctionUuid}`}>
                    See the full breakdown →
                  </Link>
                </div>
              ) : (
                <div className="state">Nothing sold in this range.</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Recent flips</h2>
                <p className="sub">
                  Showing the {data.recentFlips.length} most recent of {data.stats.flipCount}. A “~” marks a
                  flip whose ingredient prices were estimated.
                </p>
              </div>
              {data.stats.flipCount > data.recentFlips.length && (
                <Link className="btn-ghost" to={`/u/${encodeURIComponent(username)}/flips?range=${range}`}>
                  View all {data.stats.flipCount} →
                </Link>
              )}
            </div>
            <FlipsTable flips={data.recentFlips} />
          </div>
        </div>
      )}
    </main>
  );
}
