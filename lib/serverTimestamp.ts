// Server-only timestamp authority configuration, shared by the proxy
// (app/api/timestamp/route.ts) and /api/config, which reports whether
// timestamping is available. The URL never reaches the browser.

/** The configured TSA endpoint, or null when this deployment has none. */
export function tsaUrl(): string | null {
  const url = process.env.TSA_URL?.trim();
  return url ? url : null;
}

/** HTTP Basic credentials for a commercial TSA, as `user:password`. Free TSAs need none. */
export function tsaCredentials(): string | null {
  const credentials = process.env.TSA_CREDENTIALS?.trim();
  return credentials ? credentials : null;
}
