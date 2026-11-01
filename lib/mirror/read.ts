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
    await ensureCovered(fromMs, toMs);
    await pullIfStale(opts.fresh ? 0 : pullIntervalSec());
  } catch (e) {
    // Serve the local copy only for weeks it has really read; a range never
    // read would come back empty or partial, and writes plan against it.
    const st = await getState();
    const covered =
      !!st?.covered_from_ms && fromMs >= st.covered_from_ms && (st.covered_to_ms === undefined || toMs <= st.covered_to_ms);
    if (!covered) throw e;
    warning = `Toggl could not be read (${(e as Error).message}); showing the local copy.`;
  }
  const st = await getState();
  return { docs: await inRange(fromMs, toMs), dataAtMs: st?.last_pull_at?.getTime() ?? null, warning };
}
