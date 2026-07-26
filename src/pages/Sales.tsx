import { useState } from 'react';
import { fetchSalesVolume } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { SalesVolumeChart } from '../components/charts/SalesVolumeChart';
import { exactCoins } from '../lib/format';
import type { SalesCohort } from '../api/types';

/**
 * Sales volume of an Aspect of the Void by EXACT upgrade set.
 *
 * The distinction the page turns on is "and only": a sword carrying the
 * etherwarp merge and nothing else is a different product from one that is
 * also enchanted, tuned and recombobulated, and lumping them gives a volume
 * number that describes no actual item.
 *
 * Neither local store can answer this — price_rollup keeps an is_clean flag
 * with no upgrade detail, and tracked_sales covers only two players — so the
 * data is Coflnet's sold feed, which returns parsed NBT per sale.
 */

const ITEM_ID = 'ASPECT_OF_THE_VOID';
const DAY_OPTIONS = [7, 3, 1];

/**
 * What a cohort actually requires. The match mode has to be on screen: the same
 * upgrade list means "and nothing else" under exact and "at least" under
 * contains, which are different counts of different swords.
 */
function rule(c: SalesCohort): string {
  const parts = [...c.upgrades, ...c.enchants.map((e) => `${e.type} ${e.level}+`)];
  return `${parts.join(' + ')} · ${c.match === 'exact' ? 'nothing else' : 'extras allowed'}`;
}

export function Sales() {
  const [days, setDays] = useState(7);
  const { data, error, loading } = useAsync(() => fetchSalesVolume(ITEM_ID, days), [days]);

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Sales volume</h1>
        </div>
        <div className="seg seg-sm" role="group" aria-label="Window">
          {DAY_OPTIONS.map((d) => (
            <button key={d} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && <Loading label="Reading Coflnet's sold feed…" />}
      {error && <ErrorState error={error} />}

      {data && !loading && (
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Sales per hour</h2>
              </div>
            </div>
            <SalesVolumeChart cohorts={data.cohorts} />
          </div>

          {/* An empty cohort is a finding, not a rendering failure. Say which
              one and why, using what people actually bought. */}
          {data.cohorts
            .filter((c) => c.sales === 0)
            .map((c) => (
              <div className="card" key={c.key}>
                <div className="card-head">
                  <div>
                    <h2>No sales matched “{c.label}”</h2>
                  </div>
                </div>
                {data.topShapes.slice(0, 6).map((s) => (
                  <div className="breakdown-row" key={s.upgrades}>
                    <span className="breakdown-name" title={s.upgrades}>
                      {s.upgrades}
                    </span>
                    <span className="breakdown-val">{s.sales.toLocaleString('en-US')}</span>
                  </div>
                ))}
              </div>
            ))}

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Cohorts</h2>
              </div>
            </div>
            {data.cohorts.map((c) => (
              <div className="breakdown-row" key={c.key}>
                <span className="breakdown-name">
                  {c.label}
                  <span className="muted"> · {rule(c)}</span>
                </span>
                <span className="breakdown-val">
                  {c.sales.toLocaleString('en-US')} sales
                  {c.medianPrice !== null && (
                    <span className="muted"> · med {exactCoins(c.medianPrice)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {data.unclassifiedKeys.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Unclassified NBT keys</h2>
                </div>
              </div>
            </div>
          )}

          <p className="sub">
            {data.coverage.truncated && (
              <>
              </>
            )}
            {/* Coflnet's terms require attribution in the UI. */}
            {data.attribution}. 
            {data.cachedAgeSeconds > 60 && (
              <> Cached {Math.round(data.cachedAgeSeconds / 60)} min ago.</>
            )}
          </p>
        </div>
      )}
    </main>
  );
}
