import { useParams, useSearchParams } from 'react-router-dom';
import { fetchItemHistory } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { StatTile } from '../components/Stat';
import { FlipsTable } from '../components/FlipsTable';
import { CostVsPriceChart } from '../components/charts/CostVsPriceChart';
import { coins, pct, signedCoins, titleCase } from '../lib/format';

export function ItemExplorer() {
  const { itemId = '' } = useParams();
  const [params] = useSearchParams();
  const player = params.get('player') ?? undefined;

  const { data, error, loading } = useAsync(() => fetchItemHistory(itemId, player), [itemId, player]);

  if (loading) return <main className="container"><Loading /></main>;
  if (error) return <main className="container"><ErrorState error={error} /></main>;
  if (!data) return null;

  const latest = data.points[data.points.length - 1];
  const spread = latest.marketPrice - latest.craftCost;
  const marginPct = (spread / latest.craftCost) * 100;

  const spreads = data.points.map((p) => p.marketPrice - p.craftCost);
  const profitableDays = spreads.filter((s) => s > 0).length;

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{data.itemName}</h1>
          <p className="sub">
            <span className="pill">{titleCase(data.rarity)}</span> <span className="muted">{data.itemId}</span>
          </p>
        </div>
      </div>

      <div className="stack">
        <div className="grid grid-kpi">
          <StatTile label="Craft cost today" value={coins(latest.craftCost)} />
          <StatTile label="Market price today" value={coins(latest.marketPrice)} />
          <StatTile
            label="Spread before fees"
            value={signedCoins(spread)}
            note={`${pct(marginPct)} against craft cost`}
          />
          <StatTile
            label="Profitable days"
            value={`${profitableDays} / ${data.points.length}`}
            note="days in the window where price beat cost"
          />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Craft cost vs market price</h2>
              <p className="sub">The shaded band is the margin a flip has to live inside.</p>
            </div>
          </div>
          <CostVsPriceChart points={data.points} />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Your flips of this item</h2>
              <p className="sub">Every recorded craft-and-sell cycle for {data.itemName}.</p>
            </div>
          </div>
          <FlipsTable flips={data.flips} showItemLink={false} />
        </div>
      </div>
    </main>
  );
}
