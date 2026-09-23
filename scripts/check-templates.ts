// Invariants every registered PDF template must satisfy, the app's or a
// pack's (`pnpm check:templates`). The export dialog is driven by template
// declarations, and a bad one would otherwise surface only when someone
// presses Export.

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

// Ids are remembered as a device's pick; a duplicate makes the second unreachable.
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

// The default resolves, and an unknown id (a pick from a removed pack) falls back.
ok(
  PDF_TEMPLATES.some((t) => t.id === DEFAULT_TEMPLATE_ID),
  `the default template id "${DEFAULT_TEMPLATE_ID}" is in the registry`
);
ok(getTemplate('no-such-template').id === DEFAULT_TEMPLATE_ID, 'an unknown id falls back to the default');

// ---- every template builds every view ----
//
// The fixtures are fully typed so that a field added to ExportDoc must be
// added here too.

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
  billByProject: false,
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

// An empty range (e.g. a holiday week) must still build.
const emptyDoc: IndividualDoc = { ...individualDoc, days: [], grandTotal: 0 };

// A time-only document: templates that print fees must not assume a rate.
const noRateDoc: IndividualDoc = { ...individualDoc, rate: null, currency: '' };

// Billing by project: each row's code is its project name
// (billingCode === project). Templates may ignore the flag but must build.
const byProjectDoc: SummaryDoc = {
  ...summaryDoc,
  billByProject: true,
  weeks: summaryDoc.weeks.map((w) => ({
    ...w,
    rows: w.rows.map((r) => ({ ...r, label: r.project, billingCode: r.project })),
  })),
};

for (const tpl of PDF_TEMPLATES) {
  for (const [label, doc] of [
    ['individual', individualDoc],
    ['summary', summaryDoc],
    ['empty', emptyDoc],
    ['rate-less', noRateDoc],
    ['by-project', byProjectDoc],
  ] as const) {
    const def = tpl.build(doc);
    ok(def != null && typeof def === 'object', `${tpl.id}: builds a ${label} document definition`);
    ok(def.content != null, `${tpl.id}: the ${label} definition has content`);
  }
}

console.log(`✓ ${checks} template registry checks passed (${PDF_TEMPLATES.length} templates)`);
