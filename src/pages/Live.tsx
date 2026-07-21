import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  computeSpreads,
  getBazaar,
  getPlayerAuctions,
  resolveUuid,
  type BazaarSpread,
} from '../api/hypixel';
import { getApiKey } from '../lib/apiKey';
import { coins, exactCoins, pct, unitPrice } from '../lib/format';
import { ErrorState, Loading } from '../components/Layout';
import { StatTile } from '../components/Stat';
import { UpgradeInspector } from '../components/UpgradeInspector';

const VOLUME_TIERS = [
  { label: 'Any volume', value: 0 },
  { label: '10k+ / week', value: 10_000 },
  { label: '100k+ / week', value: 100_000 },
  { label: '1M+ / week', value: 1_000_000 },
];

type SortKey = 'weeklyPotential' | 'spreadPct';

export function Live() {
  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Live from Hypixel</h1>
          <p className="sub">
            Real data, fetched in the browser. This is not the flip tracker — it is what the public API can
            answer on its own, with no backend and no price history.
          </p>
        </div>
      </div>
      <div className="stack">
        <UpgradeInspector />
        <BazaarPanel />
        <PlayerAuctionsPanel />
      </div>
    </main>
  );
}

/* ---------------- bazaar (no key required) ---------------- */

function BazaarPanel() {
  const [spreads, setSpreads] = useState<BazaarSpread[] | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [minVolume, setMinVolume] = useState(100_000);
  const [sort, setSort] = useState<SortKey>('weeklyPotential');
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getBazaar();
      setTotal(Object.keys(data.products).length);
      setUpdated(data.lastUpdated);
      setSpreads(computeSpreads(data));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = (spreads ?? [])
    .filter((s) => s.weekVolume >= minVolume)
    .sort((a, b) => b[sort] - a[sort])
    .slice(0, 25);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Bazaar spreads</h2>
          <p className="sub">
            Instant-buy minus instant-sell, across every product on the bazaar. No API key needed — this
            endpoint is public.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <ErrorState error={error} />}
      {loading && !spreads && <Loading label="Fetching live bazaar…" />}

      {spreads && (
        <>
          <div className="grid grid-kpi" style={{ marginBottom: 16 }}>
            <StatTile label="Products tracked" value={total.toLocaleString('en-US')} />
            <StatTile label="With a positive spread" value={spreads.length.toLocaleString('en-US')} />
            <StatTile
              label="Snapshot age"
              value={updated ? `${Math.max(0, Math.round((Date.now() - updated) / 1000))}s` : '—'}
              note="Hypixel refreshes the bazaar continuously"
            />
          </div>

          <div className="filters" style={{ marginBottom: 14 }}>
            <div className="seg" role="group" aria-label="Minimum weekly volume">
              {VOLUME_TIERS.map((t) => (
                <button key={t.value} aria-pressed={minVolume === t.value} onClick={() => setMinVolume(t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Sort by">
              <button aria-pressed={sort === 'weeklyPotential'} onClick={() => setSort('weeklyPotential')}>
                By weekly potential
              </button>
              <button aria-pressed={sort === 'spreadPct'} onClick={() => setSort('spreadPct')}>
                By spread %
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Instant sell</th>
                  <th className="num">Instant buy</th>
                  <th className="num">Spread</th>
                  <th className="num">Spread %</th>
                  <th className="num">Weekly volume</th>
                  <th className="num">Weekly potential</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.productId}>
                    <td style={{ fontWeight: 550 }}>{s.productId.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="num">{unitPrice(s.sellPrice)}</td>
                    <td className="num">{unitPrice(s.buyPrice)}</td>
                    <td className="num">{unitPrice(s.spread)}</td>
                    <td className="num">{pct(s.spreadPct, 1)}</td>
                    <td className="num muted">{coins(s.weekVolume, 1)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {coins(s.weeklyPotential)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && <div className="state">Nothing clears that volume filter.</div>}

          <p className="sub" style={{ marginTop: 14 }}>
            Sorting by spread % puts sub-one-coin items on top, where a 0.1 → 2 coin move reads as several
            thousand percent. That is arithmetically true and practically useless, so the default ranking is
            spread × weekly volume instead. Weekly potential is a ceiling nobody actually captures — a wide
            spread usually means a thin order book.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- player auctions (key required) ---------------- */

function PlayerAuctionsPanel() {
  const [username, setUsername] = useState('');
  const [rows, setRows] = useState<
    { uuid: string; item_name: string; starting_bid: number; highest_bid_amount: number; bin: boolean; end: number }[] | null
  >(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  const key = getApiKey();

  async function run() {
    if (!key || !username.trim()) return;
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      const profile = await resolveUuid(username.trim());
      setResolved(profile.name);
      const data = await getPlayerAuctions(profile.id, key);
      setRows(data.auctions ?? []);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>A player's auctions</h2>
          <p className="sub">
            Uses <code>/v2/skyblock/auction?player=</code>, which requires a key.
          </p>
        </div>
      </div>

      {!key ? (
        <div className="state">
          No API key stored. <Link className="link" to="/settings">Add one</Link> to use this panel.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              placeholder="Minecraft username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
              aria-label="Minecraft username"
              style={{ flex: 1, minWidth: 220 }}
            />
            <button className="btn" onClick={() => void run()} disabled={loading || !username.trim()}>
              {loading ? 'Loading…' : 'Fetch'}
            </button>
          </div>

          {error && <ErrorState error={error} />}

          {rows && (
            <div style={{ marginTop: 16 }}>
              <p className="sub">
                {rows.length === 0
                  ? `${resolved} has no auctions in the API's retention window.`
                  : `${rows.length} auction${rows.length === 1 ? '' : 's'} for ${resolved}.`}
              </p>

              {rows.length > 0 && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Type</th>
                        <th className="num">Starting bid</th>
                        <th className="num">Highest bid</th>
                        <th className="num">Ends</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 40).map((a) => (
                        <tr key={a.uuid}>
                          <td style={{ fontWeight: 550 }}>{a.item_name}</td>
                          <td className="num muted">{a.bin ? 'BIN' : 'Auction'}</td>
                          <td className="num">{exactCoins(a.starting_bid)}</td>
                          <td className="num">{a.highest_bid_amount ? exactCoins(a.highest_bid_amount) : '—'}</td>
                          <td className="num muted">
                            {new Date(a.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="sub" style={{ marginTop: 14 }}>
                Each row carries an <code>item_bytes</code> blob the backend would decode to recover the
                item's craft timestamp. That decoding — and the price history to compare against — is what
                turns this list into the profit tracker.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
