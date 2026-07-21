import { Link } from 'react-router-dom';
import { usingMocks } from '../api/client';
import { TRACKED_PLAYERS } from '../config/trackedPlayers';

export function Landing() {
  return (
    <main className="container">
      <div className="landing">
        <h1 style={{ fontSize: 30 }}>Track what your craft-flips actually made.</h1>
        <p className="sub" style={{ fontSize: 15, marginTop: 12 }}>
          Every item crafted and sold on the Auction House is priced against what its ingredients and
          upgrades cost <em>on the day it was crafted</em> — not today — then netted against the AH fees
          actually paid.
        </p>

        <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {TRACKED_PLAYERS.map((p) => (
            <Link key={p.uuid} to={`/u/${p.name}`} className="card" style={{ textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 620 }}>{p.name}</div>
                  <div className="muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                    {p.uuid}
                  </div>
                </div>
                <span className="link">Dashboard →</span>
              </div>
            </Link>
          ))}
        </div>

        <p className="sub" style={{ marginTop: 22 }}>
          <Link className="link" to="/tracked">
            Scan the auction house for their live listings →
          </Link>
        </p>

        {usingMocks && (
          <p className="sub" style={{ marginTop: 18 }}>
            The dashboards run on demo data (<code>VITE_USE_MOCKS</code>) — there is no sales history to
            show until the ingest has been recording. The <Link className="link" to="/tracked">Tracked</Link>{' '}
            and <Link className="link" to="/live">Live</Link> pages use real API data now.
          </p>
        )}
      </div>
    </main>
  );
}
