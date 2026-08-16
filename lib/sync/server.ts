// Server-side availability of settings sync.
//
// Sync rides on the same MongoDB the standalone store uses, but is mode-
// independent: a Toggl-mode deployment turns it on by setting MONGODB_URI
// together with APP_MODE=toggl (which keeps the Toggl source instead of
// flipping the app to standalone — see lib/store/mongo.ts). Because /api/sync
// accepts writes, APP_PASSWORD is required exactly like the store routes.

export function syncEnabled(): boolean {
  return !!process.env.MONGODB_URI && !!process.env.APP_PASSWORD;
}

/**
 * A sync-specific misconfiguration the operator must fix, or null. Only
 * reported when the standalone misconfiguration message doesn't already cover
 * it (standalone mode surfaces its own APP_PASSWORD complaint).
 */
export function syncMisconfigured(): string | null {
  if (process.env.MONGODB_URI && !process.env.APP_PASSWORD && process.env.APP_MODE === 'toggl') {
    return 'APP_PASSWORD must be set to use settings sync (the sync store accepts writes).';
  }
  return null;
}
