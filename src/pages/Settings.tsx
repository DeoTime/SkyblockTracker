import { useState } from 'react';
import { testApiKey } from '../api/hypixel';
import { clearApiKey, getApiKey, looksLikeKey, maskKey, setApiKey } from '../lib/apiKey';

type Status = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };

export function Settings() {
  const [stored, setStored] = useState<string | null>(getApiKey());
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function save() {
    const key = draft.trim();
    if (!looksLikeKey(key)) {
      setStatus({ kind: 'err', msg: 'That does not look like a Hypixel key — they are UUIDs, e.g. 1a2b3c4d-….' });
      return;
    }

    setStatus({ kind: 'testing' });
    try {
      const { playerCount } = await testApiKey(key);
      setApiKey(key);
      setStored(key);
      setDraft('');
      setStatus({
        kind: 'ok',
        msg: `Key accepted. Hypixel reports ${playerCount.toLocaleString('en-US')} players online right now.`,
      });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    }
  }

  function forget() {
    clearApiKey();
    setStored(null);
    setStatus({ kind: 'idle' });
  }

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>API key</h1>
          <p className="sub">Needed only for the keyed endpoints on the Live page.</p>
        </div>
      </div>

      <div className="stack" style={{ maxWidth: 680 }}>
        <div
          className="card"
          style={{ borderColor: 'var(--warning)', borderWidth: 1, background: 'var(--surface-1)' }}
        >
          <h2 style={{ marginBottom: 8 }}>⚠ This is a development shortcut</h2>
          <p className="sub" style={{ margin: 0 }}>
            A key stored here lives in this browser's <code>localStorage</code> and is visible to anything
            running on the page. That is acceptable for local development on your own machine and nothing
            else. In the deployed product the operator holds a single key <strong>server-side</strong> and
            users never supply one — auction data is public, so nobody needs their own key to be tracked.
          </p>
          <p className="sub" style={{ marginBottom: 0 }}>
            Never paste a key into a chat, an issue, or a commit. If you have, regenerate it at{' '}
            <a className="link" href="https://developer.hypixel.net" target="_blank" rel="noreferrer noopener">
              developer.hypixel.net
            </a>
            .
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>{stored ? 'Replace key' : 'Add key'}</h2>
              <p className="sub">Stored locally, sent only to api.hypixel.net.</p>
            </div>
          </div>

          {stored && (
            <div className="breakdown-row">
              <span className="breakdown-name">
                Current key <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{maskKey(stored)}</span>
              </span>
              <button className="btn-ghost" onClick={forget}>
                Forget
              </button>
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
              onKeyDown={(e) => e.key === 'Enter' && save()}
              aria-label="Hypixel API key"
              style={{ flex: 1, minWidth: 260 }}
            />
            <button className="btn" onClick={save} disabled={status.kind === 'testing'}>
              {status.kind === 'testing' ? 'Checking…' : 'Verify & save'}
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

          <p className="sub" style={{ marginTop: 14 }}>
            The key is verified against <code>/v2/counts</code> before it is saved, so an invalid key never
            gets stored. Default keys allow <strong>120 requests per minute</strong>, shared across every
            process using that key.
          </p>
        </div>
      </div>
    </main>
  );
}
