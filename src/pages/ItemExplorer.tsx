import { useParams, useSearchParams } from 'react-router-dom';
import { fetchItemHistory } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { StatTile } from '../components/Stat';
import { FlipsTable } from '../components/FlipsTable';
import { CostVsPriceChart } from '../components/charts/CostVsPriceChart';
import { coins, pct, signedCoins, titleCase } from '../lib/format';
import type { ItemBuild } from '../api/types';

/**
 * One item, charted per BUILD rather than in the abstract.
 *
 * "The price of an Aspect of the Void" is not a number — a bare one goes for
 * about 6M and an etherwarped one for about 25M, and averaging across them
 * describes no sword anyone can buy. So each build gets its own pair of series:
 * what that exact configuration sells for, and what that exact configuration
 * costs to assemble.
 */

/**
 * What a build's market line actually counted. The match mode belongs on
 * screen: the same upgrade list means "and nothing else" under exact and "at
 * least" under contains, and those are different swords at different prices.
 */
function rule(b: ItemBuild): string {
  const parts = [
    ...b.cohort.upgrades,
    ...b.cohort.enchants.map((e) => `${e.type} ${e.level}+`),
    ...b.cohort.excludes.map((u) => `no ${u}`),
  ];
  return `${parts.join(' + ')} · ${b.cohort.match === 'exact' ? 'nothing else' : 'extras allowed'}`;
}

export function ItemExplorer() {
  const { itemId = '' } = useParams();
  const [params] = useSearchParams();
  const player = params.get('player') ?? undefined;

  const { data, error, loading } = useAsync(() => fetchItemHistory(itemId, player), [itemId, player]);

  if (loading) return <main className="container"><Loading /></main>;
  if (error) return <main className="container"><ErrorState error={error} /></main>;
  if (!data) return null;

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
          {data.builds.map((b) => (
            <StatTile
              key={b.key}
              label={b.label}
              value={b.latest ? signedCoins(b.latest.spread) : '—'}
              title={b.description}
              note={
                b.latest ? (
                  <>
                    {coins(b.latest.marketPrice)} sold vs {coins(b.latest.craftCost)} to build
                    {b.latest.marginPct !== null && <> · {pct(b.latest.marginPct)} margin</>}
                  </>
                ) : (
                  'No day in the window has both a price and a cost'
                )
              }
            />
          ))}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Sale price vs craft cost</h2>
            </div>
          </div>
          <CostVsPriceChart dates={data.dates} builds={data.builds} />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>What each build is</h2>
            </div>
          </div>
          {data.builds.map((b) => (
            <div className="breakdown-row" key={b.key}>
              {/* The bill of materials is long enough to clip in the row, so the
                  full list stays reachable rather than ending in an ellipsis. */}
              <span className="breakdown-name" title={b.components.map((c) => `${c.quantity}× ${c.name}`).join(' + ')}>
                {b.label}
                <span className="muted"> · {b.components.map((c) => `${c.quantity}× ${c.name}`).join(' + ')}</span>
              </span>
              <span className="breakdown-val">
                {b.salesMatched.toLocaleString('en-US')} sales
                <span className="muted"> · {rule(b)}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Your flips of this item</h2>
            </div>
          </div>
          <FlipsTable flips={data.flips} showItemLink={false} />
        </div>

        {/* The two sides of this chart come from two places with two different
            reaches, and the gaps in it are only readable if that is said. */}
        <p className="sub">
          Cost lines are priced from our own archive and run the whole window. Price lines come from
          Coflnet's sold feed, which reaches back {data.coverage.marketDays} days
          {data.coverage.truncated && ' (and the oldest day of it is short — the page cap was hit first)'}.
          {data.coverage.costEstimatedDays > 0 && (
            <>
              {' '}
              {data.coverage.costEstimatedDays} day
              {data.coverage.costEstimatedDays === 1 ? ' has' : 's have'} at least one ingredient priced from
              outside that day — the nearest snapshot we hold, or a widened window for a part we buy rarely.
            </>
          )}
          {data.coverage.marketError && <> Coflnet could not be reached, so no price line was drawn.</>}
          {/* Coflnet's terms require attribution in the UI. */}
          {' '}
          {data.attribution}.
        </p>
      </div>
    </main>
  );
}
