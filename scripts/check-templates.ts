// Registry invariants every PDF template must satisfy, its own or a pack's.
// Run with:
//   npm run check:templates
//
// The export dialog is driven entirely by what a template declares, and a
// template that declares something impossible fails at the worst moment — the
// user has picked a range, waited for the fetch and pressed Export. Everything
// here is cheap and holds for any template, so it runs against whatever the
// registry contains, pack included.

import assert from 'node:assert/strict';
import type { IndividualDoc, SummaryDoc } from '../lib/export/model.ts';
import { installResolveHooks } from './resolve-hooks.mjs';

installResolveHooks();

const { PDF_TEMPLATES, APP_TEMPLATES, DEFAULT_TEMPLATE_ID, getTemplate } = await import(
  '../lib/export/pdf/templates.ts'
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};

const KNOWN_FIELDS = ['role', 'company', 'client', 'approver', 'reference', 'engagement', 'rate'];

ok(PDF_TEMPLATES.length >= 1, 'the registry is never empty');
ok(APP_TEMPLATES.length >= 1, 'this repository ships at least one template of its own');

// An id is what a device remembers as its last pick, so two templates sharing
// one means the second is unreachable — silently, and only for the people whose
// stored pick happens to be that id.
const ids = PDF_TEMPLATES.map((t) => t.id);
ok(new Set(ids).size === ids.length, `template ids are unique (${ids.join(', ')})`);

for (const tpl of PDF_TEMPLATES) {
  ok(/^[a-z0-9-]+$/.test(tpl.id), `${tpl.id}: id is lowercase, digits and dashes`);
  ok(tpl.name.trim().length > 0, `${tpl.id}: has a name for the picker`);
  ok(tpl.description.trim().length > 0, `${tpl.id}: has a description for the picker`);
  for (const field of tpl.fields ?? []) {
    ok(KNOWN_FIELDS.includes(field), `${tpl.id}: "${field}" is a field the dialog can offer`);
  }
  // A hint the dialog will never show is a field the template forgot to ask for.
  for (const field of Object.keys(tpl.fieldHints ?? {})) {
    ok(
      (tpl.fields ?? []).includes(field as (typeof KNOWN_FIELDS)[number] as never),
      `${tpl.id}: fieldHints.${field} belongs to a field the template asks for`
    );
  }
  ok(
    tpl.locale === undefined || tpl.locale === 'en' || tpl.locale === 'cs',
    `${tpl.id}: locale is one the dialog has labels for`
  );
}

// The default has to resolve, and an unknown id has to fall back rather than
// throw — a device keeps its pick across a pack being added or removed.
ok(
  PDF_TEMPLATES.some((t) => t.id === DEFAULT_TEMPLATE_ID),
  `the default template id "${DEFAULT_TEMPLATE_ID}" is in the registry`
);
ok(getTemplate('no-such-template').id === DEFAULT_TEMPLATE_ID, 'an unknown id falls back to the default');

// ---- every template builds every view ----
//
// The fixtures are fully typed on purpose: a template reads whatever the model
// carries, so a field added to ExportDoc and not to these would leave the
// registry checked against a document no template ever actually receives.

const DAY = new Date(2026, 6, 6).getTime();

const meta = {
  title: 'Alpha Platform',
  personName: 'Jan Novák',
  role: 'Integration architect',
  company: 'Example Supplier s.r.o.',
  client: 'Example Client a.s.',
  approver: 'Petra Dvořáková',
  reference: 'TS-2026-07',
  engagement: 'Prepared under the framework agreement of 1 January 2026.',
  rate: 1125,
  rateBasis: 'hourly' as const,
  currency: 'CZK',
  fromMs: new Date(2026, 6, 1).getTime(),
  toMs: new Date(2026, 7, 1).getTime(),
  multi: false,
};

const individualDoc: IndividualDoc = {
  ...meta,
  view: 'individual',
  days: [
    {
      dateMs: DAY,
      label: 'Mon · Jul 6',
      total: 3 * 3600,
      rows: [
        {
          time: '09:00–10:30',
          startMs: DAY + 9 * 3600_000,
          endMs: DAY + 10.5 * 3600_000,
          hours: 1.5 * 3600,
          code: 'D101',
          billingCode: 'D101',
          project: 'Alpha Platform',
          warn: false,
          desc: 'Interface mapping',
        },
        {
          time: '11:00–12:30',
          startMs: DAY + 11 * 3600_000,
          endMs: DAY + 12.5 * 3600_000,
          hours: 1.5 * 3600,
          code: 'D102',
          billingCode: 'D102',
          project: 'Alpha Platform',
          warn: false,
          desc: 'Review of the integration test results',
        },
      ],
    },
  ],
  grandTotal: 3 * 3600,
};

const summaryDoc: SummaryDoc = {
  ...meta,
  view: 'summary',
  weeks: [
    {
      weekStart: DAY,
      label: 'Jul 6 – Jul 12',
      dayLabels: ['Mon 06'],
      dayDates: [DAY],
      dayTotals: [3 * 3600],
      grandTotal: 3 * 3600,
      rows: [
        {
          label: 'D101',
          billingCode: 'D101',
          project: 'Alpha Platform',
          warn: false,
          cells: [3 * 3600],
          desc: 'Interface mapping',
          dayDescs: ['Interface mapping'],
          total: 3 * 3600,
        },
      ],
    },
  ],
  grandTotal: 3 * 3600,
};

// A range with nothing in it is reachable from the dialog (a month before the
// engagement started, a holiday week) and must still produce a document.
const emptyDoc: IndividualDoc = { ...individualDoc, days: [], grandTotal: 0 };

// And a time-only document: a template that prints fees must not assume a rate.
const noRateDoc: IndividualDoc = { ...individualDoc, rate: null, currency: '' };

for (const tpl of PDF_TEMPLATES) {
  for (const [label, doc] of [
    ['individual', individualDoc],
    ['summary', summaryDoc],
    ['empty', emptyDoc],
    ['rate-less', noRateDoc],
  ] as const) {
    const def = tpl.build(doc);
    ok(def != null && typeof def === 'object', `${tpl.id}: builds a ${label} document definition`);
    ok(def.content != null, `${tpl.id}: the ${label} definition has content`);
  }
}

console.log(`✓ ${checks} template registry checks passed (${PDF_TEMPLATES.length} templates)`);
