// Settings sync document, shared by client and server.
//
// The payload holds the active settings, the Toggl-mode presets and the
// export fields. It never holds the Toggl API token (credentials stay on the
// device) or refreshSec (per device).
//
// The server keeps one document per deployment with an increasing `rev`.
// Each write names the rev it was based on; a stale write gets a 409 with the
// current document and the user picks a side.

import type { StoredSettings } from '@/lib/useTrackSource';
import type { ExportFieldValues } from '@/lib/exportFields';

export const SYNC_PAYLOAD_VERSION = 1;

export interface SyncPayload {
  v: number;
  /** StoredSettings minus token and refreshSec. Includes the active export
   * fields and each preset's own. */
  settings: Omit<StoredSettings, 'token' | 'refreshSec'>;
  /** Copy of the active export fields for older clients that read only this. */
  exportFields: ExportFieldValues;
}

/** What a successful write reports back. */
export interface SyncDocInfo {
  rev: number;
  /** ISO timestamp of the write. */
  updatedAt: string;
  /** Human label of the device that wrote it (e.g. "macOS · Chrome"). */
  device: string;
}

/** The full stored document, as GET returns it and 409s echo it. */
export interface SyncDoc extends SyncDocInfo {
  payload: SyncPayload;
}
