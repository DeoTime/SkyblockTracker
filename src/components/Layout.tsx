import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { usingMocks } from '../api/client';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const stored = localStorage.getItem('sbft-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sbft-theme', theme);
  }, [theme]);

  return (
    <button
      className="btn-ghost"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" />
          SkyBlock Flip Tracker
        </Link>
        <div className="topbar-spacer" />
        <NavLink to="/settings" className="btn-ghost">
          API key
        </NavLink>
        {usingMocks && (
          <span className="pill" title="VITE_USE_MOCKS is on — the tracker pages use demo data.">
            Demo data
          </span>
        )}
        <ThemeToggle />
      </header>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      {label}
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <div className="state">
      <strong style={{ color: 'var(--critical)' }}>Could not load.</strong>
      <div style={{ marginTop: 6 }}>{error.message}</div>
    </div>
  );
}
