// Client for /api/config — the server-side configuration the app needs on
// load, including which track source (mode) this deployment runs.

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
}

const CONFIG_FALLBACK: AppConfig = {
  mode: 'toggl',
  serverToken: false,
  passwordRequired: false,
  misconfigured: null,
  cache: { enabled: false, intervalSec: null },
  sync: { enabled: false, misconfigured: null },
};

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) return CONFIG_FALLBACK;
  // Spread over the fallback so a response from an older server (without
  // `mode`) still yields a complete config.
  const data = (await res.json()) as Partial<AppConfig>;
  return { ...CONFIG_FALLBACK, ...data };
}
