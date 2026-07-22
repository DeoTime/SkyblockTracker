import { ApiError } from './types';
import type {
  DashboardResponse,
  FlipDetail,
  FlipsPage,
  ItemHistoryResponse,
  PendingResponse,
  RangeKey,
} from './types';
import { mockDashboard, mockFlipDetail, mockFlips, mockItemHistory, mockPending } from './mock';

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

/**
 * A player's outstanding (unclaimed) auctions, priced for expected profit.
 * Needs the stored Hypixel key server-side; returns 503 until one is installed.
 */
export function fetchPending(username: string): Promise<PendingResponse> {
  return get(`/players/${encodeURIComponent(username)}/pending`, () => mockPending(username));
}

export function fetchItemHistory(itemId: string, username?: string): Promise<ItemHistoryResponse> {
  const q = username ? `?player=${encodeURIComponent(username)}` : '';
  return get(`/items/${encodeURIComponent(itemId)}/history${q}`, () => mockItemHistory(itemId));
}

export const usingMocks = USE_MOCKS;
