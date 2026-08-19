'use client';

// Post-deploy refresh hint. A tab left open across a deploy keeps running the
// old bundle, and an old bundle can do real damage: it doesn't know settings
// keys added since, so saving settings from it would silently drop them from
// the synced document. This component compares the build id inlined into this
// bundle (see next.config.js) against GET /api/version, and when they diverge
// shows a persistent toast asking the user to refresh.
//
// Checks run when the tab regains focus or becomes visible again — the exact
// moment someone returns to a long-lived tab — plus a slow background
// interval. A fresh page load is by definition current, so there is no check
// on mount. Dismissing hides the hint for that server build only; a later
// deploy brings it back.

import { useEffect, useState } from 'react';

const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? null;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum gap between checks, so focus + visibilitychange firing together
 *  (or rapid tab switching) don't burst requests. */
const CHECK_DEBOUNCE_MS = 30 * 1000;

export default function UpdateHint() {
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    // 'unversioned' means the build had no git commit to derive an id from
    // (see next.config.js) — comparisons would be meaningless, so don't poll.
    if (!CLIENT_BUILD_ID || CLIENT_BUILD_ID === 'unversioned') return;
    let cancelled = false;
    let lastCheck = 0;

    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastCheck < CHECK_DEBOUNCE_MS) return;
      lastCheck = now;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string | null };
        if (!cancelled && data.buildId) setServerBuildId(data.buildId);
      } catch {
        // Offline or transient failure — the next trigger tries again.
      }
    };

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const intervalId = setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, []);

  const stale =
    serverBuildId !== null &&
    serverBuildId !== CLIENT_BUILD_ID &&
    serverBuildId !== dismissedId;
  if (!stale) return null;

  return (
    <div className="toast update" role="alert">
      <span className="update-msg">
        A new version has been deployed — refresh to avoid saving with the old
        one.
      </span>
      <button
        type="button"
        className="btn btn-primary update-refresh"
        onClick={() => window.location.reload()}
      >
        Refresh
      </button>
      <button
        type="button"
        className="update-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => setDismissedId(serverBuildId)}
      >
        ×
      </button>
    </div>
  );
}
