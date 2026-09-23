// The export dialog's user-entered identity fields (role, company, client,
// approver, rate, currency, reference, engagement notes, start date, signature).
//
// They belong to a workspace, not the device, so one client's company or rate
// never prints on another's PDF. They live in PresetValue
// (components/SettingsPanel): recalling a workspace recalls them, and the
// dialog writes back to the active workspace. A workspace without its own set
// inherits the values in use when it was created or first recalled.
//
// This module also reads the old device-wide layout (one localStorage key per
// field), which loadSettings (lib/useTrackSource) migrates once and clears.

/** The old device-wide keys. Read once at migration, then removed. */
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
 * The full set as a workspace snapshot and the sync payload carry it. All
 * strings; empty = unset.
 *
 * Only a hand-typed `reference` is stored. A derived one (TS-2026-07) belongs
 * to the exported month and would otherwise carry into the next.
 *
 * The engagement note and role are kept per template language. The dialog
 * prints the other language's role when the template's own is empty.
 */
export interface ExportFieldValues {
  /** Role for English templates (also holds values stored before roleCs existed). */
  role: string;
  /** Role as Czech templates print it; empty = fall back to `role`. */
  roleCs: string;
  company: string;
  client: string;
  approver: string;
  rate: string;
  /** Unit `rate` is quoted per: 'md' for man-day; anything else is hourly. */
  rateBasis: string;
  currency: string;
  reference: string;
  engagementEn: string;
  engagementCs: string;
  /**
   * First billable day of the engagement, `yyyy-mm-dd`; empty = none. The
   * dialog clips its week and month presets to it (see clipRangeToStart).
   */
  startDate: string;
  /**
   * Handwritten signature scan as a PNG or JPEG `data:` URL, for the visible
   * block of a signed PDF (lib/export/pdf/sign). Empty = none.
   *
   * It travels through settings sync like the other fields, so the dialog
   * stores it only up to MAX_SIGNATURE_IMAGE_CHARS; a larger scan is used for
   * one export and not remembered.
   */
  signatureImage: string;
  /** Signature block layout: 'image-above' (default, also for empty) or 'image-left'. */
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
  rateBasis: '',
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
 * A complete value from a partial or missing one, e.g. an older workspace
 * snapshot or sync payload. Non-string values become empty.
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
    rateBasis: str(v.rateBasis),
    currency: str(v.currency),
    reference: str(v.reference),
    engagementEn: str(v.engagementEn),
    engagementCs: str(v.engagementCs),
    startDate: str(v.startDate),
    signatureImage: str(v.signatureImage),
    signatureLayout: str(v.signatureLayout),
  };
}

/** True when both sets hold the same values, so a no-op write can be skipped. */
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
 * The old device-wide fields, or null when this device has none. The caller
 * folds them into the settings and then calls clearLegacyExportFields().
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
    // Fields added after workspace scoping have no device-wide key.
    roleCs: '',
    company: read(LEGACY_KEYS.company),
    client: read(LEGACY_KEYS.client),
    approver: read(LEGACY_KEYS.approver),
    rate: read(LEGACY_KEYS.rate),
    rateBasis: '',
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

/** Remove the old keys once their values are in the settings. */
export function clearLegacyExportFields(): void {
  try {
    for (const key of Object.values(LEGACY_KEYS)) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable; the migrated copy in the settings is what matters */
  }
}
