import { useCallback, useState } from 'react';
import { setFlipExcluded, usingMocks } from '../api/client';
import type { FlipSummary } from '../api/types';

/**
 * Excluding a flip is a server write gated by the admin password. Keep the
 * password in sessionStorage so the operator types it once per browser session
 * rather than on every checkbox — never in localStorage, which would persist a
 * credential to disk for no reason.
 */
const PW_KEY = 'sbx.adminPassword';

const readStoredPassword = () => {
  try {
    return sessionStorage.getItem(PW_KEY) ?? '';
  } catch {
    return ''; // sessionStorage can throw in locked-down/private contexts
  }
};

/**
 * Owns everything the sold-items table needs to toggle a flip's exclusion: the
 * admin password, which row is mid-request, the last error, and a `refreshKey`
 * the page threads into its data-fetch deps so a successful toggle re-pulls the
 * recalculated dashboard.
 */
export function useExclusions() {
  const [password, setPassword] = useState(readStoredPassword);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const updatePassword = useCallback((pw: string) => {
    setPassword(pw);
    try {
      if (pw) sessionStorage.setItem(PW_KEY, pw);
      else sessionStorage.removeItem(PW_KEY);
    } catch {
      /* storage unavailable — the in-memory value still works for this session */
    }
  }, []);

  const toggle = useCallback(
    async (flip: FlipSummary, nextExcluded: boolean) => {
      setError(null);
      setBusyId(flip.auctionUuid);
      try {
        await setFlipExcluded(flip.auctionUuid, nextExcluded, password);
        setRefreshKey((k) => k + 1); // re-fetch so the numbers reflect the change
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [password],
  );

  // In mock mode there is no password gate; anywhere else, edits need one.
  const canEdit = usingMocks || password.length > 0;

  return { password, updatePassword, busyId, error, refreshKey, toggle, canEdit };
}
