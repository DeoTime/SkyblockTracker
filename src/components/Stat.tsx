import type { ReactNode } from 'react';

interface HeroProps {
  label: string;
  value: string;
  note?: ReactNode;
}

/** The one number the dashboard leads with. */
export function HeroFigure({ label, value, note }: HeroProps) {
  return (
    <div className="hero">
      <span className="hero-label">{label}</span>
      <span className="hero-value">{value}</span>
      {note && <span className="tile-delta">{note}</span>}
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  note?: ReactNode;
  chart?: ReactNode;
  title?: string;
}

/** A headline number with optional supporting note and sparkline. */
export function StatTile({ label, value, note, chart, title }: TileProps) {
  return (
    <div className="card" title={title}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="tile-label">{label}</div>
          <div className="tile-value">{value}</div>
          {note && <div className="tile-delta">{note}</div>}
        </div>
        {chart && <div style={{ flex: 'none', paddingTop: 6 }}>{chart}</div>}
      </div>
    </div>
  );
}
