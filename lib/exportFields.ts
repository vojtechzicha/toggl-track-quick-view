// The export dialog's identity fields (role / company / client / approver /
// rate / currency / reference / engagement notes). Their values are
// user-entered — the app itself ships no company names or rates.
//
// These belong to a WORKSPACE, not to the device: they name the engagement the
// timesheet is billed under, and a setup that tracks two clients must not
// print one client's company (or rate) on the other's PDF. So they travel
// inside PresetValue (components/SettingsPanel): every stored workspace
// captures them, recalling a workspace recalls them, and the export dialog
// writes back to whichever workspace is active. A workspace that has never
// been given its own set inherits the values in use when it was created (or
// when it is first recalled).
//
// What is left in this module is the value shape itself plus the reader for
// the pre-workspace layout — one localStorage key per field, device-wide —
// which loadSettings (lib/useTrackSource) migrates from once and then clears.

/** The pre-workspace, device-wide keys. Read once at migration, then removed. */
const LEGACY_KEYS = {
  role: 'tqv.export.role.v1',
  company: 'tqv.export.company.v1',
  client: 'tqv.export.client.v1',
  approver: 'tqv.export.approver.v1',
  rate: 'tqv.export.rate.v1',
  currency: 'tqv.export.currency.v1',
  reference: 'tqv.export.reference.v1',
  engagementEn: 'tqv.export.engagement.en.v1',
  engagementCs: 'tqv.export.engagement.cs.v1',
} as const;

/**
 * The whole set, as a workspace snapshot (and the sync payload) carries it.
 * All plain strings; empty = unset.
 *
 * Only a hand-typed `reference` is remembered. A derived one (TS-2026-07) is a
 * property of the exported month, not of the engagement, so persisting it would
 * carry July's reference into August.
 *
 * The engagement note has to be grammatical in the language it prints in, so
 * each template language keeps its own text rather than one being reused.
 */
export interface ExportFieldValues {
  role: string;
  company: string;
  client: string;
  approver: string;
  rate: string;
  currency: string;
  reference: string;
  engagementEn: string;
  engagementCs: string;
}

export const EMPTY_EXPORT_FIELDS: ExportFieldValues = {
  role: '',
  company: '',
  client: '',
  approver: '',
  rate: '',
  currency: '',
  reference: '',
  engagementEn: '',
  engagementCs: '',
};

/** Which engagement note a PDF template's language uses. */
export const engagementKey = (locale: 'en' | 'cs'): 'engagementEn' | 'engagementCs' =>
  locale === 'cs' ? 'engagementCs' : 'engagementEn';

/**
 * A complete value from a partial (or missing) one — covers workspaces stored
 * before export fields were part of a snapshot, and payloads from an older
 * app version.
 */
export function normalizeExportFields(
  v: Partial<ExportFieldValues> | null | undefined
): ExportFieldValues {
  if (!v || typeof v !== 'object') return { ...EMPTY_EXPORT_FIELDS };
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  return {
    role: str(v.role),
    company: str(v.company),
    client: str(v.client),
    approver: str(v.approver),
    rate: str(v.rate),
    currency: str(v.currency),
    reference: str(v.reference),
    engagementEn: str(v.engagementEn),
    engagementCs: str(v.engagementCs),
  };
}

/** True when both sets carry the same values (so a no-op write stays a no-op). */
export function exportFieldsEqual(
  a: Partial<ExportFieldValues> | null | undefined,
  b: Partial<ExportFieldValues> | null | undefined
): boolean {
  const x = normalizeExportFields(a);
  const y = normalizeExportFields(b);
  return (Object.keys(EMPTY_EXPORT_FIELDS) as (keyof ExportFieldValues)[]).every(
    (k) => x[k] === y[k]
  );
}

/**
 * The device-wide fields written by versions before workspace scoping, or null
 * when this device never had any. Reading is one-way: the caller folds them
 * into the settings and calls clearLegacyExportFields().
 */
export function readLegacyExportFields(): ExportFieldValues | null {
  let found = false;
  const read = (key: string): string => {
    try {
      const v = window.localStorage.getItem(key) ?? '';
      if (v) found = true;
      return v;
    } catch {
      return '';
    }
  };
  const values: ExportFieldValues = {
    role: read(LEGACY_KEYS.role),
    company: read(LEGACY_KEYS.company),
    client: read(LEGACY_KEYS.client),
    approver: read(LEGACY_KEYS.approver),
    rate: read(LEGACY_KEYS.rate),
    currency: read(LEGACY_KEYS.currency),
    reference: read(LEGACY_KEYS.reference),
    engagementEn: read(LEGACY_KEYS.engagementEn),
    engagementCs: read(LEGACY_KEYS.engagementCs),
  };
  return found ? values : null;
}

/** Drop the pre-workspace keys once their values live in the settings. */
export function clearLegacyExportFields(): void {
  try {
    for (const key of Object.values(LEGACY_KEYS)) window.localStorage.removeItem(key);
  } catch {
    /* private mode — the migrated copy in the settings is what counts */
  }
}
