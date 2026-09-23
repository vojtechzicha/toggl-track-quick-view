// In-process response cache for the Toggl proxy, so devices and tabs share
// one upstream request instead of each spending the 30 requests/hour budget.
// Enabled by TOGGL_CACHE_INTERVAL, and only for the server-held token
// (TOGGL_API_TOKEN), so every viewer sees the same user's data.
//
//  - Refreshes only when a request finds the entry older than the interval.
//    No viewers, no requests.
//  - Concurrent misses for a key share one upstream fetch.
//  - Keyed by path and query. The live range is day-aligned, so all devices
//    share one key; historical ranges get their own.
//  - Capped at MAX_STORE_ENTRIES; the oldest entry is evicted.
//  - Per server instance, in memory. Serverless cold starts begin empty.

const TOGGL_BASE = 'https://api.track.toggl.com/api/v9';
const DEFAULT_INTERVAL_SEC = 180; // 20 Toggl req/hour, under the 30 limit
const MIN_INTERVAL_SEC = 30;
const MAX_STORE_ENTRIES = 50;

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
  /** When this body was fetched from Toggl (ms epoch), i.e. the data's age. */
  at: number;
}

type StoreEntry = CachedResponse;

const store = new Map<string, StoreEntry>();
const inflight = new Map<string, Promise<StoreEntry>>();

/**
 * Refresh interval in seconds, or null when caching is off. TOGGL_CACHE_INTERVAL
 * takes seconds (min 30), or "1"/"true"/"on"/"yes" for the default.
 */
export function cacheIntervalSec(): number | null {
  const raw = process.env.TOGGL_CACHE_INTERVAL?.trim();
  if (!raw) return null;
  if (/^(1|true|on|yes)$/i.test(raw)) return DEFAULT_INTERVAL_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(MIN_INTERVAL_SEC, n);
}

async function fetchUpstream(
  path: string,
  search: string,
  auth: string
): Promise<StoreEntry> {
  const res = await fetch(`${TOGGL_BASE}/${path}${search}`, {
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
  });
  const body = await res.text();
  return {
    at: Date.now(),
    status: res.status,
    body,
    contentType: res.headers.get('content-type') || 'application/json',
  };
}

/** Store an entry, evicting the oldest when over the cap. */
function remember(key: string, entry: StoreEntry) {
  store.set(key, entry);
  while (store.size > MAX_STORE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of store) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    store.delete(oldestKey);
  }
}

/**
 * A cached Toggl response when fresh, otherwise a refreshed one. On an
 * upstream error, serves stale data if any, so a rate limit does not blank the
 * dashboard. `force` skips the cached read but still stores the result.
 */
export async function cachedToggl(
  path: string,
  search: string,
  auth: string,
  intervalSec: number,
  force = false
): Promise<CachedResponse> {
  const key = `${path}${search}`;
  const now = Date.now();
  const cached = store.get(key);
  if (!force && cached && now - cached.at < intervalSec * 1000) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchUpstream(path, search, auth)
      .then((entry) => {
        // Cache only successes, so an error never replaces a servable value.
        if (entry.status >= 200 && entry.status < 400) remember(key, entry);
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    const fresh = await pending;
    if (fresh.status >= 200 && fresh.status < 400) return fresh;
    // Upstream error: prefer stale data.
    return cached ?? fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
