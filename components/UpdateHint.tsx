'use client';

// Post-deploy refresh hint. A tab open across a deploy runs the old bundle,
// which does not know newer settings keys and would drop them from the synced
// document on its next save. Compares the bundle's build id (next.config.js)
// with GET /api/version and shows a toast when they differ.
//
// Checks on focus / visibility and every 5 minutes, not on mount (a fresh load
// is current). Dismissing hides the hint until the next deploy.

import { useEffect, useState } from 'react';

const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? null;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum gap between checks; focus and visibilitychange often fire together. */
const CHECK_DEBOUNCE_MS = 30 * 1000;

export default function UpdateHint() {
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    // 'unversioned': the build had no git commit (next.config.js). Don't poll.
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
        // Offline or transient; the next trigger retries.
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
        A new version is available. Refresh before changing settings.
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
