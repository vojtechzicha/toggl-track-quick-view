// Client half of cross-device settings sync (see app/api/sync/route.ts and
// lib/sync/model.ts for the contract).
//
// The engine itself lives in useTrackSource; this module is the toolkit:
// building/applying payloads, content hashing, the tiny fetch client, and the
// per-device sync bookmark. The bookmark (tqv.sync.v1) remembers the last
// server revision this device synced to AND the content hash of what was
// synced — comparing the current settings' hash against it is how the engine
// tells "this device changed something" apart from "nothing to do", entirely
// offline. Hashing uses a key-sorted stringify so the same content always
// hashes the same, no matter what key order a JSON round-trip produced.

import type { StoredSettings } from '@/lib/useTrackSource';
import { normalizeExportFields } from '@/lib/exportFields';
import { loadAuth, clearAuth } from '@/lib/source/auth';
import { ApiError, AuthRequiredError } from '@/lib/source/errors';
import { SYNC_PAYLOAD_VERSION, type SyncDoc, type SyncDocInfo, type SyncPayload } from './model';

const SYNC_META_KEY = 'tqv.sync.v1';

/** This device's sync bookmark: the last synced revision and its content hash. */
export interface SyncMeta {
  rev: number;
  hash: string;
}

export function loadSyncMeta(): SyncMeta | null {
  try {
    const raw = window.localStorage.getItem(SYNC_META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SyncMeta;
    return m && typeof m.rev === 'number' && typeof m.hash === 'string' ? m : null;
  } catch {
    return null;
  }
}

export function saveSyncMeta(m: SyncMeta): void {
  try {
    window.localStorage.setItem(SYNC_META_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

// ---- Content hashing ----

/** JSON.stringify with recursively sorted keys (and undefined values dropped),
 * so hashes depend on content only — never on key insertion order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/** Cheap content fingerprint (djb2 + length) — collision-resistant enough to
 * answer "did MY settings change since I last synced", which is all it does. */
export function payloadHash(p: SyncPayload): string {
  const s = stableStringify(p);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}.${s.length.toString(36)}`;
}

// ---- Payload build / apply ----

/**
 * Snapshot the syncable state: settings minus the token (a credential never
 * leaves its device) and refreshSec (a device knob).
 *
 * The export identity fields now live inside the settings (per workspace, and
 * again inside every stored workspace), so they travel in `settings` like
 * everything else. The top-level `exportFields` key is still filled with the
 * active set: it is what a client from before workspace scoping reads, and
 * dropping it would blank that client's export dialog.
 */
export function buildSyncPayload(settings: StoredSettings): SyncPayload {
  const { token: _token, refreshSec: _refreshSec, ...rest } = settings;
  return {
    v: SYNC_PAYLOAD_VERSION,
    settings: rest,
    exportFields: normalizeExportFields(settings.exportFields),
  };
}

/**
 * Apply a synced payload over the current settings, returning the value to
 * persist. The local token and refresh interval always survive. Spreading over
 * `prev` keeps any field a payload from an older app version doesn't carry —
 * and a payload written before workspace scoping carries the export fields at
 * the top level only, so they are read from there.
 */
export function applySyncPayload(prev: StoredSettings, payload: SyncPayload): StoredSettings {
  return {
    ...prev,
    ...payload.settings,
    exportFields: normalizeExportFields(
      payload.settings?.exportFields ?? payload.exportFields ?? prev.exportFields
    ),
    token: prev.token,
    refreshSec: prev.refreshSec,
  };
}

// ---- API client ----

/** A push lost the revision race; carries the server's current document. */
export class SyncConflictError extends Error {
  doc: SyncDoc;
  constructor(doc: SyncDoc) {
    super('sync conflict');
    this.name = 'SyncConflictError';
    this.doc = doc;
  }
}

async function syncApi<T>(opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const auth = loadAuth();
  const headers: Record<string, string> = {};
  if (auth?.token) headers['x-app-auth'] = auth.token;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch('/api/sync', {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401 && res.headers.get('x-app-auth') === 'required') {
    clearAuth();
    throw new AuthRequiredError();
  }
  const text = await res.text();
  if (res.status === 409) {
    try {
      const body = JSON.parse(text) as { doc?: SyncDoc };
      if (body.doc) throw new SyncConflictError(body.doc);
    } catch (e) {
      if (e instanceof SyncConflictError) throw e;
    }
    throw new ApiError(409);
  }
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = JSON.parse(text) as { detail?: string; error?: string };
      detail = body.detail ?? body.error;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, detail);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function fetchSyncDoc(): Promise<SyncDoc | null> {
  const res = await syncApi<{ doc: SyncDoc | null }>();
  return res?.doc ?? null;
}

/** Write the payload on top of `baseRev` (null = first sync: create only).
 * Throws SyncConflictError when the server has moved past baseRev. */
export async function pushSyncDoc(
  baseRev: number | null,
  payload: SyncPayload,
  device: string
): Promise<SyncDocInfo> {
  return syncApi<SyncDocInfo>({ method: 'PUT', body: { baseRev, device, payload } });
}

/** A short human label for this device, shown in conflict prompts ("changed on
 * macOS · Chrome"). Best-effort — it only has to be recognizable, not exact. */
export function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Mac/.test(ua)
    ? 'macOS'
    : /Linux/.test(ua)
    ? 'Linux'
    : 'device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
    ? 'Opera'
    : /Chrome\//.test(ua)
    ? 'Chrome'
    : /Firefox\//.test(ua)
    ? 'Firefox'
    : /Safari\//.test(ua)
    ? 'Safari'
    : 'browser';
  return `${os} · ${browser}`;
}
