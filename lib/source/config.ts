// Client for /api/config: server configuration needed on load.

export interface AppConfig {
  serverToken: boolean;
  passwordRequired: boolean;
  /** A deployment problem the operator must fix, or null. */
  misconfigured: string | null;
  cache: { enabled: boolean; intervalSec: number | null };
  /** Entries come from the server's local copy of Toggl (/api/entries, lib/mirror). */
  mirror: { enabled: boolean };
  /** Cross-device settings sync availability (see app/api/sync). */
  sync: { enabled: boolean; misconfigured: string | null };
  /**
   * Whether a timestamp authority (TSA_URL) is configured, so a signed export
   * can be PAdES-B-T. Falls back to false: offering a timestamp that never
   * happens is worse than not offering one.
   */
  timestamp: { enabled: boolean };
}

const CONFIG_FALLBACK: AppConfig = {
  serverToken: false,
  passwordRequired: false,
  misconfigured: null,
  cache: { enabled: false, intervalSec: null },
  mirror: { enabled: false },
  sync: { enabled: false, misconfigured: null },
  timestamp: { enabled: false },
};

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) return CONFIG_FALLBACK;
  // Fill fields an older server does not send.
  const data = (await res.json()) as Partial<AppConfig>;
  return { ...CONFIG_FALLBACK, ...data };
}
