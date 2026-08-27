// Where the RFC 3161 timestamp authority lives, and whether there is one.
//
// Its own module rather than a constant inside the route because /api/config
// has to report whether timestamping is available without importing a route
// handler, and because the URL is the one piece of this feature that must
// never reach the browser: the proxy decides where a request goes, not the
// page that asks for it (see app/api/timestamp/route.ts).

/** The configured TSA endpoint, or null when this deployment has none. */
export function tsaUrl(): string | null {
  const url = process.env.TSA_URL?.trim();
  return url ? url : null;
}

/**
 * HTTP Basic credentials for a commercial TSA, as `user:password`.
 *
 * Qualified timestamps are sold in packs and authenticated per request; a free
 * TSA needs none of this, which is why it is separately optional.
 */
export function tsaCredentials(): string | null {
  const credentials = process.env.TSA_CREDENTIALS?.trim();
  return credentials ? credentials : null;
}
