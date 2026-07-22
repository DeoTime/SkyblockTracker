import { useEffect, useState } from 'react';
import { fetchKeyStatus, looksLikeKey, submitApiKey, type KeyStatus } from '../lib/apiKey';
import { testApiKey } from '../api/hypixel';

type Status = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };

export function Settings() {
  const [installed, setInstalled] = useState<KeyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    fetchKeyStatus()
      .then(setInstalled)
      .catch((e: Error) => setStatus({ kind: 'err', msg: e.message }));
  }, []);

  async function save() {
    const key = draft.trim();
    if (!looksLikeKey(key)) {
      setStatus({ kind: 'err', msg: 'That does not look like a Hypixel key — they are UUIDs, e.g. 1a2b3c4d-….' });
      return;
    }
    if (!password) {
      setStatus({ kind: 'err', msg: 'Enter the admin password to install a key.' });
      return;
    }

    setStatus({ kind: 'testing' });
    try {
      // Checked here first so an obviously dead key never leaves the page. The
      // server re-checks before storing — this is a courtesy, not the gate.
      await testApiKey(key);

      const result = await submitApiKey(key, password);
      setInstalled(result);
      setDraft('');
      setPassword('');
      setStatus({ kind: 'ok', msg: result.message });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    }
  }

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>API key</h1>
        </div>
      </div>

      <div className="stack" style={{ maxWidth: 680 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>{installed?.configured ? 'Replace key' : 'Install key'}</h2>
            </div>
          </div>

          {installed?.configured && (
            <div className="breakdown-row">
              <span className="breakdown-name">
                Installed{' '}
                <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {installed.masked}
                </span>
              </span>
              <span className="muted">
                {installed.updatedAt ? new Date(installed.updatedAt).toLocaleString() : ''}
              </span>
            </div>
          )}



          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Hypixel API key"
              style={{ flex: 1, minWidth: 260 }}
            />
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              aria-label="Admin password"
              style={{ width: 180 }}
            />
            <button
              className="btn"
              onClick={save}
              disabled={status.kind === 'testing' || installed?.writable === false}
            >
              {status.kind === 'testing' ? 'Checking…' : 'Verify & install'}
            </button>
          </div>

          {status.kind === 'ok' && (
            <p className="sub" style={{ color: 'var(--good-text)', marginTop: 12 }}>
              ✓ {status.msg}
            </p>
          )}
          {status.kind === 'err' && (
            <p className="sub" style={{ color: 'var(--critical)', marginTop: 12 }}>
              ✗ {status.msg}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
