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
 * each template language keeps its own text rather than one being reused. The
 * role is translated the same way ("Integration architect" / "Integrační
 * architekt"): `role` doubles as the English text and the pre-split stored
 * value, `roleCs` is the Czech one, and the export dialog falls back to the
 * other language when the printing template's own is empty — so a role that
 * reads the same in both never has to be typed twice.
 */
export interface ExportFieldValues {
  /** Role as English templates print it — and the value stored before roleCs existed. */
  role: string;
  /** Role as Czech templates print it; empty = fall back to `role`. */
  roleCs: string;
  company: string;
  client: string;
  approver: string;
  rate: string;
  currency: string;
  reference: string;
  engagementEn: string;
  engagementCs: string;
  /**
   * First billable day of the engagement, as the date input's `yyyy-mm-dd`
   * (empty = the engagement is older than any range that will be exported).
   * The export dialog clips its week/month presets to it, so a workspace that
   * started Aug 16 exports Aug 16–31 as its first month — not a document
   * claiming the whole of August.
   */
  startDate: string;
  /**
   * The handwritten signature scan, as a `data:image/png;base64,…` URL, for the
   * visible block of a signed PDF (see lib/export/pdf/sign). Empty = none, and
   * the export dialog's file picker can always supply one for a single export
   * without storing it.
   *
   * This is user data of the same kind as the rest of this file — nothing here
   * ships with the app, and the image is never committed to the repo. It is
   * remembered per workspace like every other field, which also means it
   * travels through settings sync: a scan is a few tens of kilobytes as
   * base64, so the dialog caps what it will store rather than letting a
   * multi-megabyte photo into a document that syncs on every settings change.
   */
  signatureImage: string;
  /**
   * How the signature block arranges the image and the certificate details:
   * 'image-above' (the default) or 'image-left'. Empty = the default.
   */
  signatureLayout: string;
}

/** Largest signature scan the dialog will remember, as base64 characters. */
export const MAX_SIGNATURE_IMAGE_CHARS = 256 * 1024;

export const EMPTY_EXPORT_FIELDS: ExportFieldValues = {
  role: '',
  roleCs: '',
  company: '',
  client: '',
  approver: '',
  rate: '',
  currency: '',
  reference: '',
  engagementEn: '',
  engagementCs: '',
  startDate: '',
  signatureImage: '',
  signatureLayout: '',
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
    roleCs: str(v.roleCs),
    company: str(v.company),
    client: str(v.client),
    approver: str(v.approver),
    rate: str(v.rate),
    currency: str(v.currency),
    reference: str(v.reference),
    engagementEn: str(v.engagementEn),
    engagementCs: str(v.engagementCs),
    startDate: str(v.startDate),
    signatureImage: str(v.signatureImage),
    signatureLayout: str(v.signatureLayout),
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
    // Fields younger than the workspace scoping never had a device-wide key.
    roleCs: '',
    company: read(LEGACY_KEYS.company),
    client: read(LEGACY_KEYS.client),
    approver: read(LEGACY_KEYS.approver),
    rate: read(LEGACY_KEYS.rate),
    currency: read(LEGACY_KEYS.currency),
    reference: read(LEGACY_KEYS.reference),
    engagementEn: read(LEGACY_KEYS.engagementEn),
    engagementCs: read(LEGACY_KEYS.engagementCs),
    startDate: '',
    signatureImage: '',
    signatureLayout: '',
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
