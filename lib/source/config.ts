// Client for /api/config: server configuration needed on load, including the
// source mode.

import type { SourceMode } from './types';

export interface AppConfig {
  /** Which backend this deployment serves. */
  mode: SourceMode;
  serverToken: boolean;
  passwordRequired: boolean;
  /** A deployment problem the operator must fix (e.g. standalone without APP_PASSWORD). */
  misconfigured: string | null;
  cache: { enabled: boolean; intervalSec: number | null };
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
  mode: 'toggl',
  serverToken: false,
  passwordRequired: false,
  misconfigured: null,
  cache: { enabled: false, intervalSec: null },
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
