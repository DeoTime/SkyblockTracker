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
import { OutstandingBox } from '../components/OutstandingBox';
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
          {/* Split: realised performance to date on the left, expected
              performance from still-live listings on the right. */}
          <div className="grid grid-2">
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
                <StatTile label="Avg margin" value={pct(data.stats.avgMarginPct)} />
                <StatTile label="Coins / hour" value={coins(data.stats.coinsPerHour)} />
              </div>
            </div>

            <OutstandingBox username={username} />
          </div>

          <div className="card">
            <ProfitAreaChart flips={data.recentFlips} />
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Net profit by item</h2>
                </div>
              </div>
              <ItemProfitBars items={data.byItem} onSelect={(id) => navigate(`/item/${id}`)} />
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Best single flip</h2>
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
