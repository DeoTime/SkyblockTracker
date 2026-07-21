/**
 * Local-only storage for a Hypixel API key, so the dev Live view can call the
 * keyed endpoints before a backend exists.
 *
 * This is a DEVELOPMENT AFFORDANCE, not the production design. A key held in the
 * browser is readable by anything running on the page and by anyone with
 * devtools open. In the real product the operator holds one key server-side and
 * users never supply one — see BACKEND.md §3.
 */

const STORAGE_KEY = 'sbft-hypixel-key';

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Hypixel keys are UUIDs. Cheap client-side shape check before spending a call. */
export function looksLikeKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.trim());
}

/** Never render a key in full — enough to recognise, not enough to leak. */
export function maskKey(key: string): string {
  if (key.length < 12) return '••••';
  return `${key.slice(0, 4)}••••••••••••${key.slice(-4)}`;
}
