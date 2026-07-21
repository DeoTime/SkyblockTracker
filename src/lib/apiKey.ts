/**
 * The Hypixel API key lives on the server, not in this browser.
 *
 * It used to sit in localStorage so the Live view could call keyed endpoints
 * before a backend existed. That meant every visitor needed their own key, and
 * the key was readable by anything running on the page. Now the operator
 * installs one key on the box and nobody else ever supplies one — see
 * BACKEND.md §3.
 *
 * The key is never sent back to the browser. Reads return only a masked form,
 * which is enough to tell two keys apart and useless to anyone else.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

export interface KeyStatus {
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
  /** False when the server has no ADMIN_PASSWORD set — the form is inert. */
  writable: boolean;
}

async function unwrap(res: Response) {
  const body = await res.json().catch(() => ({}) as { error?: string });
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export async function fetchKeyStatus(): Promise<KeyStatus> {
  return (await unwrap(await fetch(`${BASE}/key`, { headers: { Accept: 'application/json' } }))) as KeyStatus;
}

/**
 * Install a key. The password is sent per-request and deliberately never
 * persisted — storing it would just recreate the problem this change removed,
 * one level up.
 */
export async function submitApiKey(
  key: string,
  password: string,
): Promise<KeyStatus & { message: string }> {
  const res = await fetch(`${BASE}/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ key: key.trim(), password }),
  });
  return (await unwrap(res)) as KeyStatus & { message: string };
}

/** Hypixel keys are UUIDs. Cheap client-side shape check before spending a call. */
export function looksLikeKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.trim());
}
