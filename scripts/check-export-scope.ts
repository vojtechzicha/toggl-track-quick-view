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

// ---- migration off the pre-workspace keys ----
eq(readLegacyExportFields(), null, 'a device that never had the old keys migrates nothing');
store.set('tqv.export.company.v1', 'Acme');
store.set('tqv.export.engagement.cs.v1', 'Smlouva č. 1');
const legacy = readLegacyExportFields();
eq(legacy?.company, 'Acme', 'the old company key is read');
eq(legacy?.engagementCs, 'Smlouva č. 1', 'the old Czech engagement key is read');
eq(legacy?.role, '', 'keys that were never set read empty');
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
