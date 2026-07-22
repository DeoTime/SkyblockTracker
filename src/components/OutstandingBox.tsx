import { Link } from 'react-router-dom';
import { fetchPending } from '../api/client';
import { ApiError } from '../api/types';
import type { PendingListing } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { coins, duration, exactCoins, signedCoins, signedPct } from '../lib/format';
import { HeroFigure } from './Stat';

const STATUS: Record<PendingListing['status'], { label: string; cls: string }> = {
  active: { label: 'Listed', cls: 'pos' },
  sold: { label: 'Sold · unclaimed', cls: 'muted' },
  expired: { label: 'Expired', cls: 'neg' },
};

/**
 * Expected profit from a player's still-in-flight auctions. Fetches on its own —
 * this is the only read that needs the server-side Hypixel key, so when no key
 * is installed it shows a prompt rather than failing the whole dashboard.
 */
export function OutstandingBox({ username }: { username: string }) {
  const { data, error, loading } = useAsync(() => fetchPending(username), [username]);
  const nowIso = new Date().toISOString();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Outstanding listings</h2>
        {data && <span className="card-note">Expected profit if your listings sell</span>}
      </div>

      {loading && <div className="state">Loading…</div>}

      {error &&
        (error instanceof ApiError && error.status === 503 ? (
          <div className="state">
            No Hypixel key is installed.{' '}
            <Link className="link" to="/settings">
              Add one
            </Link>{' '}
            to see a player's live listings.
          </div>
        ) : (
          <div className="state">
            <strong style={{ color: 'var(--critical)' }}>Could not load.</strong>
            <div style={{ marginTop: 6 }}>{error.message}</div>
          </div>
        ))}

      {data && !loading && (
        data.listings.length === 0 ? (
          <div className="state">No auctions in flight right now.</div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <HeroFigure
              label="Expected net profit"
              value={signedCoins(data.totals.expectedNet)}
              note={
                <>
                  {data.totals.counts.active} listed · {data.totals.counts.sold} sold, unclaimed
                  {data.totals.counts.expired > 0 && <> · {data.totals.counts.expired} expired</>}
                  <br />
                  {exactCoins(data.totals.expectedSaleValue)} sale − {exactCoins(data.totals.expectedFees)} fees −{' '}
                  {exactCoins(data.totals.expectedCost)} cost
                </>
              }
            />

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th className="num">Sale</th>
                    <th className="num">Est. net</th>
                    <th className="num">Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {data.listings.map((l) => {
                    const s = STATUS[l.status];
                    return (
                      <tr key={l.auctionUuid}>
                        <td>
                          <div className="item-cell">
                            <Link to={`/item/${l.itemId}`} className="link">
                              {l.itemName}
                            </Link>
                            {l.unpricedUpgrades > 0 && (
                              <span className="pill" title={`${l.unpricedUpgrades} upgrade(s) could not be priced`}>
                                +?
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={s.cls === 'muted' ? 'muted' : undefined} style={s.cls === 'pos' ? { color: 'var(--good-text)' } : s.cls === 'neg' ? { color: 'var(--critical)' } : undefined}>
                            {s.label}
                          </span>
                        </td>
                        <td className="num">{coins(l.expectedSale)}</td>
                        <td
                          className="num"
                          style={{
                            fontWeight: 600,
                            color: l.status === 'expired' ? 'var(--text-muted)' : l.netProfit >= 0 ? 'var(--good-text)' : 'var(--critical)',
                          }}
                          title={`${signedPct(l.profitPct)} margin`}
                        >
                          {l.status === 'expired' ? '—' : signedCoins(l.netProfit)}
                        </td>
                        <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                          {l.status === 'active' ? `in ${duration(nowIso, l.endsAt)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  );
}
