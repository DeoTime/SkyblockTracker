import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { fetchFlips } from '../api/client';
import type { RangeKey } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { FlipsTable } from '../components/FlipsTable';

const PAGE_SIZE = 50;

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All' },
];

/** Every flip, paginated. The dashboard only ever shows a preview. */
export function AllFlips() {
  const { username = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const range = (params.get('range') as RangeKey) || 'all';
  const [page, setPage] = useState(0);

  const { data, error, loading } = useAsync(
    () => fetchFlips(username, range, page, PAGE_SIZE),
    [username, range, page],
  );

  function changeRange(next: RangeKey) {
    setPage(0);
    setParams({ range: next });
  }

  const first = data ? data.page * data.pageSize + 1 : 0;
  const last = data ? Math.min((data.page + 1) * data.pageSize, data.totalFlips) : 0;

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>All flips</h1>
          <p className="sub">
            <Link className="link" to={`/u/${encodeURIComponent(username)}`}>
              ← back to {username}'s dashboard
            </Link>
          </p>
        </div>

        <div className="filters">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.key} aria-pressed={range === r.key} onClick={() => changeRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <Loading />}
      {error && <ErrorState error={error} />}

      {data && !loading && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>
                {data.totalFlips} flip{data.totalFlips === 1 ? '' : 's'}
              </h2>
              <p className="sub">
                Showing {first}–{last} of {data.totalFlips}.
              </p>
            </div>
            {data.totalPages > 1 && (
              <div className="filters">
                <button className="btn-ghost" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
                  ← Prev
                </button>
                <span className="card-note">
                  Page {data.page + 1} of {data.totalPages}
                </span>
                <button
                  className="btn-ghost"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={data.page >= data.totalPages - 1}
                >
                  Next →
                </button>
              </div>
            )}
          </div>

          <FlipsTable flips={data.flips} />
        </div>
      )}
    </main>
  );
}
