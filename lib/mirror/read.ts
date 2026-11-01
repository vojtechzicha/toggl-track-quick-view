// Reading the mirror for a date range, pulling first when the last pull is
// stale. Shared by the dashboard route and the MCP tools.

import { ensureCovered, pullIfStale, pullIntervalSec } from './sync';
import { getState, inRange } from './store';
import type { MirrorDoc } from './model';

export interface MirrorRead {
  docs: MirrorDoc[];
  /** When Toggl was last read (ms epoch). */
  dataAtMs: number | null;
  /** Set when Toggl could not be reached and the mirror is served as it is. */
  warning: string | null;
}

export async function readMirror(fromMs: number, toMs: number, opts: { fresh?: boolean } = {}): Promise<MirrorRead> {
  let warning: string | null = null;
  try {
    await ensureCovered(fromMs);
    await pullIfStale(opts.fresh ? 0 : pullIntervalSec());
  } catch (e) {
    const st = await getState();
    if (!st?.covered_from_ms) throw e; // nothing to serve yet
    warning = `Toggl could not be read (${(e as Error).message}); showing the local copy.`;
  }
  const st = await getState();
  return { docs: await inRange(fromMs, toMs), dataAtMs: st?.last_pull_at?.getTime() ?? null, warning };
}
