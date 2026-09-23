// Whether settings sync is available. It uses the store's MongoDB in either
// mode; a Toggl deployment enables it with MONGODB_URI plus APP_MODE=toggl
// (lib/store/mongo.ts). /api/sync writes, so APP_PASSWORD is required.

export function syncEnabled(): boolean {
  return !!process.env.MONGODB_URI && !!process.env.APP_PASSWORD;
}

/**
 * A sync misconfiguration, or null. Toggl mode only: standalone mode reports
 * its own missing APP_PASSWORD.
 */
export function syncMisconfigured(): string | null {
  if (process.env.MONGODB_URI && !process.env.APP_PASSWORD && process.env.APP_MODE === 'toggl') {
    return 'APP_PASSWORD must be set to use settings sync (the sync store accepts writes).';
  }
  return null;
}
