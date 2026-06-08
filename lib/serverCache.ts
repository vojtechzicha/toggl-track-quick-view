// Shared, in-process response cache for the Toggl proxy.
//
// Purpose: let several devices/tabs share ONE upstream Toggl request instead of
// each spending from the (Free-plan) 30-requests/hour budget. It is enabled by
// the TOGGL_CACHE_INTERVAL env var and is only used for the server-held token
// (TOGGL_API_TOKEN), so every cached viewer is the same user looking at the
// same data.
//
// Design notes:
//  - Lazy, demand-driven: the cache only refreshes when a request arrives and
//    finds the entry older than the interval. Nobody viewing the page => no
//    requests are ever made. There is no background timer.
//  - Single-flight: concurrent misses for the same key share one upstream
//    fetch, so N devices polling at once cause exactly one Toggl call.
//  - Keyed by API path AND query: the live dashboard's range is day-aligned
//    ("this week up to ~now"), so every device computes an identical range and
//    still collapses onto one upstream call — while a historical week/month
//    request (a different range, same path) gets its own key instead of
//    colliding with the live cache. A `force` refresh bypasses the cached read
//    but still updates the store, so later viewers get the fresh copy.
//  - Bounded: the store is capped (an LRU-ish eviction of the oldest entry) so
//    selecting many historical ranges can't grow it without limit on a
//    long-running server.
//  - In-memory, per server instance. On a single long-running server (next
//    start, or a warm serverless instance) that is genuinely shared; this is
//    the right, simplest fit for the private single-user deploy this targets.

const TOGGL_BASE = 'https://api.track.toggl.com/api/v9';
const DEFAULT_INTERVAL_SEC = 180; // ~20 Toggl req/hour, safely under the 30 limit
const MIN_INTERVAL_SEC = 30;
const MAX_STORE_ENTRIES = 50; // cap distinct (path+range) keys; evict the oldest

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
}

interface StoreEntry extends CachedResponse {
  at: number;
}

const store = new Map<string, StoreEntry>();
const inflight = new Map<string, Promise<StoreEntry>>();

/**
 * Configured refresh interval in seconds, or null when server caching is off.
 * TOGGL_CACHE_INTERVAL accepts a positive number of seconds, or a boolean-ish
 * flag ("1"/"true"/"on"/"yes") to enable with the default interval.
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

/** Record a successful entry, evicting the oldest if the store is over its cap. */
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
 * Returns a cached Toggl response when fresh, otherwise refreshes it (sharing a
 * single upstream fetch across concurrent callers). On an upstream failure a
 * stale cached value is served when available, so a transient error or a
 * rate-limit doesn't blank the dashboard.
 *
 * With `force`, the cached read is skipped (the caller wants live data — e.g. a
 * manual refresh of a historical week) but the freshly fetched value still
 * updates the store, so subsequent viewers benefit.
 */
export async function cachedToggl(
  path: string,
  search: string,
  auth: string,
  intervalSec: number,
  force = false
): Promise<CachedResponse> {
  const key = `${path}${search}`; // range included — see file header
  const now = Date.now();
  const cached = store.get(key);
  if (!force && cached && now - cached.at < intervalSec * 1000) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchUpstream(path, search, auth)
      .then((entry) => {
        // Only cache successful bodies; a 402/429/5xx shouldn't evict a value
        // we can keep serving while Toggl recovers.
        if (entry.status >= 200 && entry.status < 400) remember(key, entry);
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    const fresh = await pending;
    if (fresh.status >= 200 && fresh.status < 400) return fresh;
    // Upstream errored: prefer stale-but-valid data over propagating the error.
    return cached ?? fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
