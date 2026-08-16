// Shared shape of the cross-device settings sync document (client + server).
//
// The payload is everything the user thinks of as "their setup": the active
// settings, the stored Toggl-mode workspaces (presets), and the export
// dialog's identity fields. Two things deliberately never sync:
//  - the Toggl API token — a live credential stays on the device it was
//    entered on (mirroring how PresetValue has always excluded it);
//  - refreshSec — a device/network knob, not part of "the setup".
//
// The server stores exactly one document per deployment (these are
// single-tenant personal deploys behind APP_PASSWORD) with a monotonically
// increasing `rev`. Every write carries the rev it was based on, so a stale
// device can never silently clobber a newer setup — it gets a 409 with the
// current document and the user picks a side (see lib/sync/client.ts).

import type { StoredSettings } from '@/lib/useTrackSource';
import type { ExportFieldValues } from '@/lib/exportFields';

export const SYNC_PAYLOAD_VERSION = 1;

export interface SyncPayload {
  v: number;
  /** StoredSettings minus the credential and the per-device refresh knob.
   * Carries the export dialog's identity fields twice over: the active set
   * (settings.exportFields) and each stored workspace's own. */
  settings: Omit<StoredSettings, 'token' | 'refreshSec'>;
  /** The active export identity fields, mirrored for clients from before they
   * were scoped to a workspace (they read the payload's top level only). */
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
