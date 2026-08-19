// Content checks for the export identity fields (company / client / rate /
// engagement note …) now that they are scoped to a workspace. Run with:
//   npm run check:export
//
// The load-bearing claims are about storage, not layout:
//  - a device that still has the old per-field localStorage keys migrates them
//    into the settings once, and the keys are then gone;
//  - the sync payload carries the fields inside `settings` AND mirrors them at
//    the top level, so a client from before the scoping still reads them;
//  - a payload written by such a client (top level only) is applied, not lost.
//
// Plus the two per-workspace details added later: the role's Czech counterpart
// is a field of its own, and the workspace start date clips a preset range so a
// mid-month engagement start never exports a full-month document.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      return { url: new URL(specifier.slice(2) + '.ts', ROOT).href, shortCircuit: true };
    }
    // Next resolves extensionless relative imports; node needs them spelled out.
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(u)) return { url: u.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

// The modules under test only touch storage through `window.localStorage`.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const {
  EMPTY_EXPORT_FIELDS,
  clearLegacyExportFields,
  exportFieldsEqual,
  normalizeExportFields,
  readLegacyExportFields,
} = await import('../lib/exportFields.ts');
const { buildSyncPayload, applySyncPayload } = await import('../lib/sync/client.ts');
const { clipRangeToStart, fromDateInput } = await import('../lib/export/range.ts');
const { DAY_MS } = await import('../lib/timesheet/constants.ts');

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};
const ok = (v: unknown, msg: string) => {
  checks++;
  assert.ok(v, msg);
};

// ---- normalize / compare ----
eq(normalizeExportFields(undefined), EMPTY_EXPORT_FIELDS, 'missing fields normalise to empty');
eq(
  normalizeExportFields({ company: 'Acme', rate: 1125 } as never).company,
  'Acme',
  'a partial value keeps its strings'
);
eq(
  normalizeExportFields({ company: 'Acme', rate: 1125 } as never).rate,
  '',
  'a non-string value is dropped rather than printed'
);
ok(exportFieldsEqual(undefined, EMPTY_EXPORT_FIELDS), 'absent equals empty');
ok(!exportFieldsEqual({ company: 'Acme' }, EMPTY_EXPORT_FIELDS), 'a set field is not empty');
ok(
  exportFieldsEqual({ company: 'Acme' }, { company: 'Acme', client: '' }),
  'the same values compare equal however partial the shapes'
);
eq(
  normalizeExportFields({ role: 'Integration architect', roleCs: 'Integrační architekt' }).roleCs,
  'Integrační architekt',
  'the Czech role is its own field'
);
eq(
  normalizeExportFields({ role: 'Integration architect' }).roleCs,
  '',
  'a value stored before the split normalises with an empty Czech role'
);
eq(
  normalizeExportFields({ startDate: '2026-08-16' }).startDate,
  '2026-08-16',
  'the start date travels with the fields'
);
ok(
  !exportFieldsEqual({ role: 'X' }, { roleCs: 'X' }),
  'the two languages of the role are not interchangeable'
);

// ---- clipping a preset range to the workspace start date ----
const aug = { fromMs: fromDateInput('2026-08-01')!, toMs: fromDateInput('2026-09-01')! };
eq(
  clipRangeToStart(aug, '2026-08-16'),
  { fromMs: fromDateInput('2026-08-16')!, toMs: aug.toMs },
  'a month preset starts at a mid-month engagement start'
);
eq(clipRangeToStart(aug, ''), aug, 'no start date leaves the range alone');
eq(clipRangeToStart(aug, '2026-05-01'), aug, 'a start before the range leaves it alone');
eq(clipRangeToStart(aug, '2026-08-01'), aug, 'a start on the first day is a no-op');
const sep15 = fromDateInput('2026-09-15')!;
eq(
  clipRangeToStart(aug, '2026-09-15'),
  { fromMs: sep15, toMs: sep15 },
  'a range wholly before the start collapses to empty — never the pre-engagement range'
);
eq(
  clipRangeToStart(aug, '2026-08-31'),
  { fromMs: aug.toMs - DAY_MS, toMs: aug.toMs },
  'a start on the last day leaves that one day'
);
eq(clipRangeToStart(aug, 'not-a-date'), aug, 'a malformed start date is ignored');

// ---- migration off the pre-workspace keys ----
eq(readLegacyExportFields(), null, 'a device that never had the old keys migrates nothing');
store.set('tqv.export.company.v1', 'Acme');
store.set('tqv.export.engagement.cs.v1', 'Smlouva č. 1');
const legacy = readLegacyExportFields();
eq(legacy?.company, 'Acme', 'the old company key is read');
eq(legacy?.engagementCs, 'Smlouva č. 1', 'the old Czech engagement key is read');
eq(legacy?.role, '', 'keys that were never set read empty');
eq(legacy?.roleCs, '', 'fields younger than the scoping migrate as empty');
eq(legacy?.startDate, '', 'the start date has no pre-workspace key either');
clearLegacyExportFields();
eq(readLegacyExportFields(), null, 'the old keys are gone once migrated');

// ---- sync payload ----
type Settings = Parameters<typeof buildSyncPayload>[0];
const settings = {
  token: 'secret',
  refreshSec: 180,
  workspaceId: 1,
  accountName: 'Jane Doe',
  exportName: '',
  exportFields: { ...EMPTY_EXPORT_FIELDS, company: 'Acme', rate: '1125' },
  presets: [],
} as unknown as Settings;

const payload = buildSyncPayload(settings);
eq(payload.settings.exportFields?.company, 'Acme', 'the payload carries the fields in settings');
eq(payload.exportFields.company, 'Acme', 'and mirrors them for pre-scoping clients');
ok(!('token' in payload.settings), 'the credential never leaves the device');

const applied = applySyncPayload(settings, payload);
eq(applied.exportFields.company, 'Acme', 'applying a payload restores the fields');
eq(applied.token, 'secret', 'the local token survives');
eq(applied.refreshSec, 180, 'the local refresh interval survives');

// A document written before the fields were scoped: top level only.
const oldPayload = {
  v: payload.v,
  settings: { ...payload.settings, exportFields: undefined },
  exportFields: { ...EMPTY_EXPORT_FIELDS, company: 'Older Client' },
} as unknown as typeof payload;
eq(
  applySyncPayload(settings, oldPayload).exportFields.company,
  'Older Client',
  'a pre-scoping payload is read from its top level'
);

// A pre-scoping client keeps pushing back the nested copy it once pulled from
// us while editing only the top level, so a disagreement means the top level is
// the copy that was actually written.
const oldClientEdit = {
  v: payload.v,
  settings: { ...payload.settings, exportFields: { ...EMPTY_EXPORT_FIELDS, company: 'Acme' } },
  exportFields: { ...EMPTY_EXPORT_FIELDS, company: 'Edited On Old Client' },
} as unknown as typeof payload;
eq(
  applySyncPayload(settings, oldClientEdit).exportFields.company,
  'Edited On Old Client',
  'a top level that disagrees with the nested copy wins'
);
eq(
  applySyncPayload(settings, payload).exportFields.company,
  'Acme',
  'and a payload whose copies agree is unaffected by that rule'
);

// A document from a client too old to carry them at all: keep what we have.
const barePayload = {
  v: payload.v,
  settings: { ...payload.settings, exportFields: undefined },
  exportFields: undefined,
} as unknown as typeof payload;
eq(
  applySyncPayload(settings, barePayload).exportFields.company,
  'Acme',
  'a payload without any export fields leaves the local ones alone'
);

console.log(`✓ ${checks} export-scope checks passed`);
