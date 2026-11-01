// Whether settings sync is available: MONGODB_URI (lib/store/mongo.ts) plus
// APP_PASSWORD, since /api/sync writes.

export function syncEnabled(): boolean {
  return !!process.env.MONGODB_URI && !!process.env.APP_PASSWORD;
}

/** A sync misconfiguration, or null. */
export function syncMisconfigured(): string | null {
  if (process.env.MONGODB_URI && !process.env.APP_PASSWORD) {
    return 'APP_PASSWORD must be set to use settings sync (the sync store accepts writes).';
  }
  return null;
}
