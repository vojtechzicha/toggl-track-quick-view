// The export dialog's identity fields (role / company / client / approver /
// rate / currency / reference / engagement notes). Their values are
// user-entered and stored in localStorage under per-field keys — the app
// itself ships no company names or rates.
//
// This module is the single owner of those keys: the export dialog reads and
// writes through it, and settings sync (lib/sync) snapshots/restores the whole
// set so the fields travel across devices with the rest of the settings.
// Every write announces itself on EXPORT_FIELDS_EVENT so the sync engine
// knows the payload changed without the dialog having to talk to the hook.

export const ROLE_KEY = 'tqv.export.role.v1';
export const COMPANY_KEY = 'tqv.export.company.v1';
export const CLIENT_KEY = 'tqv.export.client.v1';
export const APPROVER_KEY = 'tqv.export.approver.v1';
export const RATE_KEY = 'tqv.export.rate.v1';
export const CURRENCY_KEY = 'tqv.export.currency.v1';
// Only a hand-typed reference is remembered. A derived one (TS-2026-07) is a
// property of the exported month, not of the engagement, so persisting it would
// carry July's reference into August.
export const REFERENCE_KEY = 'tqv.export.reference.v1';
// The engagement note has to be grammatical in the language it prints in, so
// each template language keeps its own text rather than one being reused.
export const ENGAGEMENT_KEY = (locale: 'en' | 'cs') => `tqv.export.engagement.${locale}.v1`;

/** Fired on window whenever any export field is written. */
export const EXPORT_FIELDS_EVENT = 'tqv:export-fields-changed';

/** The whole set, as the sync payload carries it. All plain strings; empty = unset. */
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

export const readStored = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

/** Persist a field, or drop it when blank. No-ops when storage is unavailable. */
export const writeStored = (key: string, value: string): void => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode — the export itself still works.
  }
  try {
    window.dispatchEvent(new Event(EXPORT_FIELDS_EVENT));
  } catch {
    /* ignore */
  }
};

export function readExportFields(): ExportFieldValues {
  return {
    role: readStored(ROLE_KEY),
    company: readStored(COMPANY_KEY),
    client: readStored(CLIENT_KEY),
    approver: readStored(APPROVER_KEY),
    rate: readStored(RATE_KEY),
    currency: readStored(CURRENCY_KEY),
    reference: readStored(REFERENCE_KEY),
    engagementEn: readStored(ENGAGEMENT_KEY('en')),
    engagementCs: readStored(ENGAGEMENT_KEY('cs')),
  };
}

export function writeExportFields(v: ExportFieldValues): void {
  writeStored(ROLE_KEY, v.role ?? '');
  writeStored(COMPANY_KEY, v.company ?? '');
  writeStored(CLIENT_KEY, v.client ?? '');
  writeStored(APPROVER_KEY, v.approver ?? '');
  writeStored(RATE_KEY, v.rate ?? '');
  writeStored(CURRENCY_KEY, v.currency ?? '');
  writeStored(REFERENCE_KEY, v.reference ?? '');
  writeStored(ENGAGEMENT_KEY('en'), v.engagementEn ?? '');
  writeStored(ENGAGEMENT_KEY('cs'), v.engagementCs ?? '');
}
