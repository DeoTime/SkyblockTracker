import { ApiError } from './types';
import type { DashboardResponse, FlipDetail, FlipsPage, ItemHistoryResponse, RangeKey } from './types';
import { mockDashboard, mockFlipDetail, mockFlips, mockItemHistory } from './mock';

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== 'false';
const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

/** Simulated latency so loading states are exercised in mock mode. */
const MOCK_DELAY = 220;

async function get<T>(path: string, mock: () => T): Promise<T> {
  if (USE_MOCKS) {
    await new Promise((r) => setTimeout(r, MOCK_DELAY));
    return mock();
  }

  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(message, res.status);
  }

  return (await res.json()) as T;
}

export function fetchDashboard(username: string, range: RangeKey): Promise<DashboardResponse> {
  return get(
    `/players/${encodeURIComponent(username)}/dashboard?range=${range}`,
    () => mockDashboard(username, range),
  );
}

export function fetchFlips(
  username: string,
  range: RangeKey,
  page: number,
  pageSize = 50,
): Promise<FlipsPage> {
  return get(
    `/players/${encodeURIComponent(username)}/flips?range=${range}&page=${page}&pageSize=${pageSize}`,
    () => mockFlips(username, range, page, pageSize),
  );
}

export function fetchFlip(auctionUuid: string): Promise<FlipDetail> {
  return get(`/flips/${encodeURIComponent(auctionUuid)}`, () => mockFlipDetail(auctionUuid));
}

export function fetchItemHistory(itemId: string, username?: string): Promise<ItemHistoryResponse> {
  const q = username ? `?player=${encodeURIComponent(username)}` : '';
  return get(`/items/${encodeURIComponent(itemId)}/history${q}`, () => mockItemHistory(itemId));
}

export const usingMocks = USE_MOCKS;

export interface LiveAuction {
  uuid: string;
  item_name: string;
  starting_bid: number;
  highest_bid_amount: number;
  bin: boolean;
  end: number;
}

/**
 * A player's in-flight auctions, fetched by the server with its stored key.
 *
 * No mock branch: there is nothing to fake here, and this is the one call that
 * proves the installed key works end to end. It fails loudly when no key is
 * installed, which is the useful behaviour for a diagnostic panel.
 */
export async function fetchPlayerAuctions(
  username: string,
): Promise<{ player: { uuid: string; username: string }; auctions: LiveAuction[] }> {
  const res = await fetch(`${BASE}/players/${encodeURIComponent(username)}/auctions`, {
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}) as { error?: string });
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  return body as { player: { uuid: string; username: string }; auctions: LiveAuction[] };
}
