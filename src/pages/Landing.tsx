import { Link } from 'react-router-dom';
import { TRACKED_PLAYERS } from '../config/trackedPlayers';

export function Landing() {
  return (
    <main className="container">
      <div className="landing">
        <h1 style={{ fontSize: 30 }}>AH flip tracker</h1>

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

      </div>
    </main>
  );
}
