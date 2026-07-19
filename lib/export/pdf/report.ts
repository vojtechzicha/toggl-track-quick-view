// The "report" PDF template: a multi-page, editorially typeset document — cover,
// summary with totals by project and billing code, a chronological day log, and a
// sign-off page. Registered twice (English and Czech) over one builder; all text
// lives in the string tables below. Uses the embedded Fraunces / IBM Plex Mono
// cuts (see reportFonts.ts) next to pdfmake's bundled Roboto.
//
// Money is optional: with an hourly rate in the export options the report carries
// fee columns and an investment box; without one it stays a time-only document.

import type { TDocumentDefinitions, Content, ContentTable, TableCell } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';
import { DAY_MS } from '@/lib/timesheet/constants';
import type { PdfTemplate } from './templates';

type ReportLocale = 'en' | 'cs';

// ---- palette (warm paper tones with a deep teal accent) ----

const R = {
  ink: '#16140F',
  ink2: '#403A2F',
  muted: '#7A7263',
  faint: '#A39A88',
  line: '#E0DACC',
  line2: '#EEE9DD',
  wash: '#F5F1E7',
  accent: '#14564F',
  ochre: '#B0792E',
  paper: '#FCFBF7',
};

// Project dot colors, assigned in first-seen order and cycled when exceeded.
const PROJECT_COLORS = ['#14564F', '#B0792E', '#4A5D7E', '#6B4E71', '#556B2F', '#8B5A2B'];

/** Printable width of an A4 portrait page with the 48pt side margins below. */
const CW = 499;

// ---- localized strings ----

interface Strings {
  localeTag: string;
  docType: string;
  docTitle: string;
  confidential: string;
  metaClient: string;
  metaProjects: string;
  metaRef: string;
  metaPreparedBy: string;
  metaEffort: string;
  metaFees: string;
  metaIssued: string;
  summary: string;
  atAGlance: string;
  kpiHours: string;
  kpiHoursNote: (md: string) => string;
  kpiDays: string;
  kpiDaysNote: (avg: string) => string;
  kpiCodes: string;
  kpiCodesNote: (nProjects: number) => string;
  kpiFees: string;
  kpiFeesNote: string;
  kpiEntries: string;
  kpiEntriesNote: string;
  byProject: string;
  byCode: string;
  thProject: string;
  thHours: string;
  thShare: string;
  thRate: string;
  thFees: string;
  thCode: string;
  thTime: string;
  thDesc: string;
  total: string;
  periodTotal: string;
  detailTitle: string;
  detailFirst: string;
  detailCont: string;
  signoffFees: string;
  signoffPlain: string;
  feesForPeriod: string;
  feesTotal: string;
  feesNote: string;
  preparedBy: string;
  approvedBy: string;
  dateLine: string;
  basisTitle: string;
  basis: string;
  page: (n: number, m: number) => string;
  hours: (n: number) => string;
  daysWord: (n: number) => string;
  lead: (a: {
    client: string;
    range: string;
    hours: string;
    days: number;
    codes: number;
    projects: number;
    fees: string | null;
  }) => string;
  declaration: (a: {
    client: string;
    ref: string;
    range: string;
    hours: string;
    fees: string | null;
  }) => string;
}

const EN: Strings = {
  localeTag: 'en-GB',
  docType: 'Professional services · Timesheet report',
  docTitle: 'Timesheet report',
  confidential: 'Confidential',
  metaClient: 'Client',
  metaProjects: 'Projects',
  metaRef: 'Reference',
  metaPreparedBy: 'Prepared by',
  metaEffort: 'Time recorded',
  metaFees: 'Fees (excl. VAT)',
  metaIssued: 'Issued',
  summary: 'Summary',
  atAGlance: 'Period at a glance',
  kpiHours: 'Hours recorded',
  kpiHoursNote: (md) => `${md} man-days at 8 h`,
  kpiDays: 'Working days',
  kpiDaysNote: (avg) => `${avg} h a day on average`,
  kpiCodes: 'Billing codes',
  kpiCodesNote: (n) => (n > 1 ? `across ${n} projects` : 'one project'),
  kpiFees: 'Fees',
  kpiFeesNote: 'excl. VAT',
  kpiEntries: 'Entries',
  kpiEntriesNote: 'time records',
  byProject: 'By project',
  byCode: 'By billing code',
  thProject: 'Project',
  thHours: 'Hours',
  thShare: 'Share',
  thRate: 'Rate',
  thFees: 'Fees',
  thCode: 'Code',
  thTime: 'Time',
  thDesc: 'Description',
  total: 'Total',
  periodTotal: 'Period total',
  detailTitle: 'Detailed time log',
  detailFirst: 'chronological',
  detailCont: 'continued',
  signoffFees: 'Investment & sign-off',
  signoffPlain: 'Confirmation & sign-off',
  feesForPeriod: 'Fees for the period',
  feesTotal: 'Total fees (excl. VAT)',
  feesNote:
    'All recorded time is chargeable. Fees follow from the recorded hours at the agreed ' +
    'hourly rate and exclude expenses and VAT.',
  preparedBy: 'Prepared by',
  approvedBy: 'Approved by',
  dateLine: 'Date · ____ / ____ / ________',
  basisTitle: 'Basis of preparation',
  basis:
    'Each line is recorded against a project and billing code from the engagement’s ' +
    'tracker, with start and end times where available. Hours carry the same rounding ' +
    'the timesheet shows on screen. This document is confidential and prepared for the ' +
    'named client only.',
  page: (n, m) => `Page ${n} of ${m}`,
  hours: (n) => (n === 1 ? 'hour' : 'hours'),
  daysWord: (n) => (n === 1 ? 'day' : 'days'),
  lead: ({ client, range, hours, days, codes, projects, fees }) => {
    const codePart = codes === 1 ? 'one billing code' : `${codes} billing codes`;
    const projPart = projects > 1 ? ` on ${projects} projects` : '';
    const feePart = fees ? ` Fees for the period come to ${fees}, excluding VAT.` : '';
    return (
      `This report covers the services delivered to ${client} during ${range}. ` +
      `${hours} hours were recorded over ${days} working days, spread across ` +
      `${codePart}${projPart}.${feePart} All recorded time is chargeable to the engagement.`
    );
  },
  declaration: ({ client, ref, range, hours, fees }) =>
    `I confirm that the time recorded in this report is a true and accurate record of ` +
    `the services delivered to ${client} under reference ${ref} for the period ${range}. ` +
    `The total submitted for approval is ${hours} hours` +
    (fees ? `, with fees of ${fees} excluding VAT.` : `.`),
};

const CS: Strings = {
  localeTag: 'cs-CZ',
  docType: 'Výkaz poskytnutých služeb',
  docTitle: 'Výkaz práce',
  confidential: 'Důvěrné',
  metaClient: 'Klient',
  metaProjects: 'Projekty',
  metaRef: 'Reference',
  metaPreparedBy: 'Zpracoval(a)',
  metaEffort: 'Vykázaný čas',
  metaFees: 'Odměna (bez DPH)',
  metaIssued: 'Vystaveno',
  summary: 'Souhrn',
  atAGlance: 'Přehled období',
  kpiHours: 'Vykázané hodiny',
  kpiHoursNote: (md) => `${md} MD po 8 h`,
  kpiDays: 'Pracovní dny',
  kpiDaysNote: (avg) => `průměrně ${avg} h denně`,
  kpiCodes: 'Účtovací kódy',
  kpiCodesNote: (n) => (n > 1 ? `napříč ${n} projekty` : 'jeden projekt'),
  kpiFees: 'Odměna',
  kpiFeesNote: 'bez DPH',
  kpiEntries: 'Záznamy',
  kpiEntriesNote: 'časových záznamů',
  byProject: 'Podle projektů',
  byCode: 'Podle účtovacích kódů',
  thProject: 'Projekt',
  thHours: 'Hodiny',
  thShare: 'Podíl',
  thRate: 'Sazba',
  thFees: 'Odměna',
  thCode: 'Kód',
  thTime: 'Čas',
  thDesc: 'Popis',
  total: 'Celkem',
  periodTotal: 'Celkem za období',
  detailTitle: 'Podrobný rozpis práce',
  detailFirst: 'chronologicky',
  detailCont: 'pokračování',
  signoffFees: 'Odměna a schválení',
  signoffPlain: 'Potvrzení a schválení',
  feesForPeriod: 'Odměna za období',
  feesTotal: 'Odměna celkem (bez DPH)',
  feesNote:
    'Veškerý vykázaný čas je účtovatelný. Odměna vychází z vykázaných hodin a sjednané ' +
    'hodinové sazby; nezahrnuje výdaje ani DPH.',
  preparedBy: 'Zpracoval(a)',
  approvedBy: 'Schválil(a)',
  dateLine: 'Datum · ____ / ____ / ________',
  basisTitle: 'Způsob vykazování',
  basis:
    'Každý řádek je veden na projekt a účtovací kód podle evidence zakázky, u záznamů ' +
    's časem včetně začátku a konce. Hodiny jsou zaokrouhleny stejně jako v aplikaci. ' +
    'Dokument je důvěrný a je určen výhradně uvedenému klientovi.',
  page: (n, m) => `Strana ${n} z ${m}`,
  hours: () => 'hodin',
  // Czech numeral declension: 1 den, 2–4 dny, 5+ dnů.
  daysWord: (n) => (n === 1 ? 'den' : n >= 2 && n <= 4 ? 'dny' : 'dnů'),
  lead: ({ client, range, hours, days, codes, projects, fees }) => {
    const dayPart = days === 1 ? 'pracovní den' : days >= 2 && days <= 4 ? 'pracovní dny' : 'pracovních dnů';
    const codePart = codes === 1 ? 'jednom účtovacím kódu' : `${codes} účtovacích kódech`;
    // "ve 2/3/4 projektech", "v 5 projektech" — the preposition follows the numeral.
    const projPart =
      projects > 1 ? ` ${projects >= 2 && projects <= 4 ? 've' : 'v'} ${projects} projektech` : '';
    const feePart = fees ? ` Celková odměna za období je ${fees} bez DPH.` : '';
    return (
      `Tento výkaz shrnuje služby poskytnuté klientovi ${client} v období ${range}. ` +
      `Vykázaný čas činí ${hours} h za ${days} ${dayPart} na ${codePart}${projPart}.` +
      `${feePart} Veškerý uvedený čas je účtovatelný v rámci zakázky.`
    );
  },
  declaration: ({ client, ref, range, hours, fees }) =>
    `Potvrzuji, že čas uvedený v tomto výkazu odpovídá skutečně odvedené práci pro ` +
    `klienta ${client} pod referencí ${ref} za období ${range}. Ke schválení předkládám ` +
    `celkem ${hours} h` +
    (fees ? `, čemuž odpovídá odměna ${fees} bez DPH.` : `.`),
};

// ---- locale formatting ----

const DAYS: Record<ReportLocale, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  cs: ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'],
};
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(ms: number, locale: ReportLocale, withYear: boolean): string {
  const d = new Date(ms);
  const dayName = DAYS[locale][d.getDay()];
  if (locale === 'cs') {
    const core = `${dayName} ${d.getDate()}. ${d.getMonth() + 1}.`;
    return withYear ? `${core} ${d.getFullYear()}` : core;
  }
  const core = `${dayName} ${String(d.getDate()).padStart(2, '0')} ${MONTHS_EN[d.getMonth()]}`;
  return withYear ? `${core} ${d.getFullYear()}` : core;
}

function fmtRange(fromMs: number, toMs: number, locale: ReportLocale): string {
  const a = new Date(fromMs);
  const b = new Date(toMs - DAY_MS); // inclusive last day
  if (locale === 'cs') {
    return `${a.getDate()}. ${a.getMonth() + 1}. – ${b.getDate()}. ${b.getMonth() + 1}. ${b.getFullYear()}`;
  }
  return `${a.getDate()} ${MONTHS_EN[a.getMonth()]} – ${b.getDate()} ${MONTHS_EN[b.getMonth()]} ${b.getFullYear()}`;
}

/** Rounded seconds → localized decimal hours ("126.5" / "126,5"). */
function hoursNum(secs: number, tag: string, maxFrac = 2): string {
  return new Intl.NumberFormat(tag, { maximumFractionDigits: maxFrac }).format(secs / 3600);
}

/** Whole-currency amount ("1 125 Kč" / "CZK 1,125"); falls back for unknown codes. */
function moneyFmt(tag: string, currency: string, maxFrac = 0): (n: number) => string {
  try {
    const f = new Intl.NumberFormat(tag, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFrac,
    });
    f.format(1); // probe — an invalid code throws here, not at construction
    return (n) => f.format(n);
  } catch {
    const f = new Intl.NumberFormat(tag, { maximumFractionDigits: maxFrac });
    return (n) => `${f.format(n)}${currency ? ` ${currency}` : ''}`;
  }
}

/**
 * Round fee amounts so the printed rows sum exactly to the printed total
 * (largest-remainder, same idea as the acceptance sheet's MD column).
 */
function allocMoney(exact: number[]): { rows: number[]; total: number } {
  const total = Math.round(exact.reduce((a, b) => a + b, 0));
  const floors = exact.map((v) => Math.floor(v + 1e-9));
  let leftover = total - floors.reduce((a, b) => a + b, 0);
  const byLoss = exact
    .map((v, i) => ({ loss: v - Math.floor(v + 1e-9), i }))
    .sort((a, b) => b.loss - a.loss || a.i - b.i);
  for (let k = 0; k < byLoss.length && leftover > 0; k++, leftover--) floors[byLoss[k].i] += 1;
  return { rows: floors, total };
}

// ---- data shaping ----

interface Line {
  dateMs: number;
  time: string | null;
  code: string;
  project: string;
  desc: string;
  secs: number;
}

/** Flatten either view into chronological lines; summary-view lines have no clock times. */
function collectLines(doc: ExportDoc): Line[] {
  const lines: Line[] = [];
  if (doc.view === 'individual') {
    for (const day of doc.days) {
      for (const r of day.rows) {
        lines.push({
          dateMs: day.dateMs,
          time: r.time,
          code: r.billingCode || r.code,
          project: r.project,
          desc: r.desc,
          secs: r.hours,
        });
      }
    }
  } else {
    for (const week of doc.weeks) {
      week.dayDates.forEach((dateMs, ci) => {
        for (const row of week.rows) {
          if (row.cells[ci] <= 0) continue;
          lines.push({
            dateMs,
            time: null,
            code: row.billingCode || row.label,
            project: row.project,
            desc: row.dayDescs[ci],
            secs: row.cells[ci],
          });
        }
      });
    }
    lines.sort((a, b) => a.dateMs - b.dateMs);
  }
  return lines;
}

// ---- building blocks ----

/** Colored project dot next to a label (drawn — the embedded fonts have no ● glyph). */
function dotted(color: string, text: string, style: string): Content {
  return {
    columns: [
      { width: 9, canvas: [{ type: 'ellipse', x: 3, y: 5.2, r1: 2.6, r2: 2.6, color }] },
      { text, style },
    ],
    columnGap: 0,
  };
}

function sectionH(text: string): Content {
  return { text: text.toUpperCase(), style: 'sectionH', margin: [0, 16, 0, 6] };
}

/** Page heading: serif title, small uppercase note right, heavy rule underneath. */
function phead(title: string, note: string): Content[] {
  return [
    {
      columns: [
        { text: title, style: 'pheadTitle' },
        { text: note.toUpperCase(), style: 'pheadNote', alignment: 'right', margin: [0, 8, 0, 0] },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0, lineWidth: 1.5, lineColor: R.ink }], margin: [0, 4, 0, 14] },
  ];
}

const rowTableLayout = {
  hLineWidth: (i: number, node: ContentTable) =>
    i === 1 ? 1.2 : i === node.table.body.length ? 1.2 : i === 0 ? 0 : 0.5,
  hLineColor: (i: number, node: ContentTable) =>
    i === 1 || i === node.table.body.length ? R.ink : R.line2,
  vLineWidth: () => 0,
  paddingTop: () => 4,
  paddingBottom: () => 4,
  paddingLeft: () => 5,
  paddingRight: () => 5,
};

// ---- the builder ----

function buildReport(doc: ExportDoc, locale: ReportLocale): TDocumentDefinitions {
  const L = locale === 'cs' ? CS : EN;
  const generatedAt = Date.now();
  const lines = collectLines(doc);
  const hasTimes = doc.view === 'individual';
  const rate = doc.rate;
  const money = moneyFmt(L.localeTag, doc.currency || 'CZK');
  const rateMoney = moneyFmt(L.localeTag, doc.currency || 'CZK', 2);
  const fee = (secs: number) => (secs / 3600) * (rate ?? 0);

  const client = doc.client || doc.company || doc.title || '';
  const totalSecs = doc.grandTotal;
  const range = fmtRange(doc.fromMs, doc.toMs, locale);
  const from = new Date(doc.fromMs);
  const ref = `TS-${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
  const h = (secs: number) => hoursNum(secs, L.localeTag);

  // Aggregations in first-seen order.
  const byProject = new Map<string, number>();
  const byCode = new Map<string, { project: string; code: string; secs: number }>();
  const dayMs = new Set<number>();
  for (const l of lines) {
    dayMs.add(l.dateMs);
    byProject.set(l.project, (byProject.get(l.project) ?? 0) + l.secs);
    const key = `${l.project} ${l.code}`;
    const agg = byCode.get(key) ?? { project: l.project, code: l.code, secs: 0 };
    agg.secs += l.secs;
    byCode.set(key, agg);
  }
  const nDays = dayMs.size;
  const nCodes = new Set(lines.map((l) => l.code)).size;
  const projectNames = [...byProject.keys()].filter(Boolean);
  const nProjects = Math.max(projectNames.length, 1);
  const projColor = new Map(projectNames.map((p, i) => [p, PROJECT_COLORS[i % PROJECT_COLORS.length]]));
  const dot = (project: string, text: string, style: string): TableCell =>
    projColor.has(project) ? (dotted(projColor.get(project) as string, text, style) as TableCell) : { text, style };

  const projRows = [...byProject.entries()];
  const projFees = rate != null ? allocMoney(projRows.map(([, s]) => fee(s))) : null;
  const codeRows = [...byCode.entries()].sort((a, b) => b[1].secs - a[1].secs);
  const codeFees = rate != null ? allocMoney(codeRows.map(([, v]) => fee(v.secs))) : null;
  const totalFee = projFees ? projFees.total : null;

  // -- cover --

  const initials = (doc.personName || '·')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const cover: Content[] = [
    {
      columns: [
        {
          width: '*',
          columns: [
            {
              width: 34,
              stack: [
                { canvas: [{ type: 'ellipse', x: 16, y: 16, r1: 16, r2: 16, lineWidth: 1.4, lineColor: R.ink }] },
                { text: initials, style: 'glyph', margin: [0, -22, 0, 0] },
              ],
            },
            {
              width: 'auto',
              margin: [10, 3, 0, 0],
              stack: [
                { text: doc.personName, style: 'brandName' },
                ...(doc.role ? [{ text: doc.role.toUpperCase(), style: 'brandRole', margin: [0, 2, 0, 0] } as Content] : []),
              ],
            },
          ],
        },
        {
          width: 'auto',
          table: { body: [[{ text: L.confidential.toUpperCase(), style: 'chip' }]] },
          layout: {
            hLineWidth: () => 0.75,
            vLineWidth: () => 0.75,
            hLineColor: () => R.line,
            vLineColor: () => R.line,
            paddingTop: () => 4,
            paddingBottom: () => 4,
            paddingLeft: () => 9,
            paddingRight: () => 9,
          },
        },
      ],
      columnGap: 10,
    },
    { text: L.docType.toUpperCase(), style: 'doctype', margin: [0, 120, 0, 0] },
    { text: client, style: 'coverTitle', margin: [0, 12, 0, 0] },
    { text: range, style: 'coverSub', margin: [0, 8, 0, 0] },
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 64, h: 3, color: R.accent }], margin: [0, 20, 0, 0] },
    {
      absolutePosition: { x: 48, y: 640 },
      table: {
        widths: [CW / 2 - 14, CW / 2 - 14],
        body: [
          [
            { stack: [{ text: L.metaClient.toUpperCase(), style: 'metaK' }, { text: client, style: 'metaVSerif' }] },
            {
              stack: [
                { text: L.metaProjects.toUpperCase(), style: 'metaK' },
                { text: projectNames.length ? projectNames.join(' · ') : doc.title, style: 'metaV' },
              ],
            },
          ],
          [
            { stack: [{ text: L.metaRef.toUpperCase(), style: 'metaK' }, { text: ref, style: 'metaVMono' }] },
            { stack: [{ text: L.metaPreparedBy.toUpperCase(), style: 'metaK' }, { text: doc.personName, style: 'metaV' }] },
          ],
          [
            {
              stack: [
                { text: L.metaEffort.toUpperCase(), style: 'metaK' },
                { text: `${h(totalSecs)} h · ${nDays} ${L.daysWord(nDays)}`, style: 'metaVMono' },
              ],
            },
            totalFee != null
              ? { stack: [{ text: L.metaFees.toUpperCase(), style: 'metaK' }, { text: money(totalFee), style: 'metaVMono' }] }
              : {
                  stack: [
                    { text: L.metaIssued.toUpperCase(), style: 'metaK' },
                    { text: fmtDate(generatedAt, locale, true), style: 'metaV' },
                  ],
                },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 ? 1 : i === 3 ? 0 : 0.5),
        hLineColor: (i: number) => (i === 0 ? R.line : R.line2),
        vLineWidth: (i: number) => (i === 1 ? 0.5 : 0),
        vLineColor: () => R.line2,
        paddingTop: () => 11,
        paddingBottom: () => 11,
        paddingLeft: (i: number) => (i === 1 ? 18 : 0),
        paddingRight: (i: number) => (i === 0 ? 18 : 0),
      },
    },
    { text: '', pageBreak: 'after' },
  ];

  // -- summary page --

  const kpiCell = (k: string, v: Content, d: string): TableCell => ({
    stack: [{ text: k.toUpperCase(), style: 'kpiK' }, v, { text: d, style: 'kpiD' }],
  });
  const kpis: Content = {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [
        [
          kpiCell(
            L.kpiHours,
            { text: [{ text: h(totalSecs), style: 'kpiV' }, { text: ' h', style: 'kpiVUnit' }], margin: [0, 4, 0, 2] },
            L.kpiHoursNote(hoursNum(totalSecs / 8, L.localeTag))
          ),
          kpiCell(L.kpiDays, { text: String(nDays), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiDaysNote(nDays ? hoursNum(totalSecs / nDays, L.localeTag, 1) : '0')),
          kpiCell(L.kpiCodes, { text: String(nCodes), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiCodesNote(nProjects)),
          totalFee != null
            ? kpiCell(L.kpiFees, { text: money(totalFee), style: 'kpiVSmall', margin: [0, 7, 0, 3] }, L.kpiFeesNote)
            : kpiCell(L.kpiEntries, { text: String(lines.length), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiEntriesNote),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.75,
      hLineColor: () => R.line,
      vLineWidth: (i: number) => (i === 0 || i === 4 ? 0.75 : 0.5),
      vLineColor: (i: number) => (i === 0 || i === 4 ? R.line : R.line2),
      paddingTop: () => 10,
      paddingBottom: () => 10,
      paddingLeft: () => 11,
      paddingRight: () => 11,
    },
  };

  const pct = (secs: number) =>
    `${Math.round((secs / Math.max(totalSecs, 1)) * 100)}${locale === 'cs' ? ' %' : '%'}`;

  const projTable: Content = {
    table: {
      headerRows: 1,
      widths: rate != null ? ['*', 52, 44, 70, 76] : ['*', 60, 52],
      body: [
        [
          { text: L.thProject.toUpperCase(), style: 'th' },
          { text: L.thHours.toUpperCase(), style: 'th', alignment: 'right' },
          { text: L.thShare.toUpperCase(), style: 'th', alignment: 'right' },
          ...(rate != null
            ? [
                { text: L.thRate.toUpperCase(), style: 'th', alignment: 'right' as const },
                { text: L.thFees.toUpperCase(), style: 'th', alignment: 'right' as const },
              ]
            : []),
        ],
        ...projRows.map(([name, secs], i): TableCell[] => [
          dot(name, name || doc.title, 'td'),
          { text: h(secs), style: 'tdNum', alignment: 'right' },
          { text: pct(secs), style: 'tdMuted', alignment: 'right' },
          ...(rate != null && projFees
            ? [
                { text: `${rateMoney(rate)}/h`, style: 'tdMuted', alignment: 'right' as const },
                { text: money(projFees.rows[i]), style: 'tdNum', alignment: 'right' as const },
              ]
            : []),
        ]),
        [
          { text: L.total, style: 'totalTd' },
          { text: h(totalSecs), style: 'totalTdNum', alignment: 'right' },
          { text: '100' + (locale === 'cs' ? ' %' : '%'), style: 'totalTdNum', alignment: 'right' },
          ...(rate != null && totalFee != null
            ? [
                { text: '', style: 'totalTd' },
                { text: money(totalFee), style: 'totalTdNum', alignment: 'right' as const },
              ]
            : []),
        ],
      ],
    },
    layout: rowTableLayout,
  };

  const codeTable: Content = {
    table: {
      headerRows: 1,
      widths: rate != null ? [90, '*', 60, 76] : [90, '*', 60],
      body: [
        [
          { text: L.thCode.toUpperCase(), style: 'th' },
          { text: L.thProject.toUpperCase(), style: 'th' },
          { text: L.thHours.toUpperCase(), style: 'th', alignment: 'right' },
          ...(rate != null ? [{ text: L.thFees.toUpperCase(), style: 'th', alignment: 'right' as const }] : []),
        ],
        ...codeRows.map(([, v], i): TableCell[] => [
          { text: v.code, style: 'tdMono' },
          dot(v.project, v.project || doc.title, 'td'),
          { text: h(v.secs), style: 'tdNum', alignment: 'right' },
          ...(rate != null && codeFees
            ? [{ text: money(codeFees.rows[i]), style: 'tdNum', alignment: 'right' as const }]
            : []),
        ]),
        [
          { text: L.total, style: 'totalTd', colSpan: 2 },
          {},
          { text: h(totalSecs), style: 'totalTdNum', alignment: 'right' },
          ...(rate != null && totalFee != null
            ? [{ text: money(totalFee), style: 'totalTdNum', alignment: 'right' as const }]
            : []),
        ],
      ],
    },
    layout: rowTableLayout,
  };

  const summaryPage: Content[] = [
    ...phead(L.summary, ref),
    {
      text: L.lead({
        client,
        range,
        hours: h(totalSecs),
        days: nDays,
        codes: nCodes,
        projects: nProjects,
        fees: totalFee != null ? money(totalFee) : null,
      }),
      style: 'lead',
    },
    sectionH(L.atAGlance),
    kpis,
    ...(projectNames.length > 0 ? [sectionH(L.byProject), projTable] : []),
    sectionH(L.byCode),
    codeTable,
    { text: '', pageBreak: 'after' },
  ];

  // -- detail log --

  // No fee column here on purpose: whole-currency rounding would make identical
  // lines show amounts a unit apart. Fees live in the summary tables and the
  // investment box, where the per-project allocation stays consistent.
  const detailCols = 2 + (hasTimes ? 1 : 0) + (doc.multi ? 1 : 0) + 1;
  const detailWidths: (string | number)[] = [
    ...(hasTimes ? [62] : []),
    64,
    ...(doc.multi ? [16] : []),
    '*',
    44,
  ];
  const detailHead: TableCell[] = [
    ...(hasTimes ? [{ text: L.thTime.toUpperCase(), style: 'th' }] : []),
    { text: L.thCode.toUpperCase(), style: 'th' },
    ...(doc.multi ? [{ text: '', style: 'th' }] : []),
    { text: L.thDesc.toUpperCase(), style: 'th' },
    { text: L.thHours.toUpperCase(), style: 'th', alignment: 'right' as const },
  ];

  const detailBody: TableCell[][] = [detailHead];
  const dayFillRows = new Set<number>();
  for (const ms of [...dayMs].sort((a, b) => a - b)) {
    const dayLines = lines.filter((l) => l.dateMs === ms);
    const daySecs = dayLines.reduce((s, l) => s + l.secs, 0);
    dayFillRows.add(detailBody.length);
    detailBody.push([
      { text: fmtDate(ms, locale, true), style: 'dayHdr', colSpan: detailCols - 1 },
      ...Array(detailCols - 2).fill({}),
      { text: `${h(daySecs)} h`, style: 'dayHdrNum', alignment: 'right' as const },
    ]);
    for (const l of dayLines) {
      detailBody.push([
        ...(hasTimes ? [{ text: l.time ?? '', style: 'tdMonoMuted' }] : []),
        { text: l.code, style: 'tdMono' },
        ...(doc.multi ? [dot(l.project, '', 'td')] : []),
        { text: l.desc, style: 'td' },
        { text: h(l.secs), style: 'tdNum', alignment: 'right' as const },
      ]);
    }
  }
  detailBody.push([
    { text: L.periodTotal, style: 'totalTd', colSpan: detailCols - 1 },
    ...Array(detailCols - 2).fill({}),
    { text: `${h(totalSecs)} h`, style: 'totalTdNum', alignment: 'right' as const },
  ]);

  const detailPage: Content[] = [
    ...phead(L.detailTitle, `${L.detailFirst} · ${ref}`),
    {
      table: { headerRows: 1, widths: detailWidths, body: detailBody, dontBreakRows: true },
      layout: {
        ...rowTableLayout,
        fillColor: (rowIndex: number) => (dayFillRows.has(rowIndex) ? R.wash : null),
      },
    },
    { text: '', pageBreak: 'after' },
  ];

  // -- sign-off page --

  const investBox: Content[] =
    rate != null && projFees && totalFee != null
      ? [
          sectionH(L.feesForPeriod),
          {
            table: {
              widths: [270, 90],
              body: [
                ...projRows.map(([name, secs], i): TableCell[] => [
                  dot(name, `${name || doc.title} · ${h(secs)} h × ${rateMoney(rate)}/h`, 'td'),
                  { text: money(projFees.rows[i]), style: 'tdNum', alignment: 'right' },
                ]),
                [
                  { text: L.feesTotal, style: 'investTotal' },
                  { text: money(totalFee), style: 'investTotalNum', alignment: 'right' },
                ],
              ],
            },
            layout: {
              hLineWidth: (i: number, node: ContentTable) =>
                i === 0 || i === node.table.body.length ? 1 : 0.5,
              hLineColor: (i: number, node: ContentTable) =>
                i === 0 || i === node.table.body.length ? R.ink : R.line2,
              vLineWidth: (i: number) => (i === 0 || i === 2 ? 1 : 0),
              vLineColor: () => R.ink,
              fillColor: (rowIndex: number, node: ContentTable) =>
                rowIndex === node.table.body.length - 1 ? R.ink : null,
              paddingTop: () => 6,
              paddingBottom: () => 6,
              paddingLeft: () => 12,
              paddingRight: () => 12,
            },
          },
          { text: L.feesNote, style: 'smallMuted', margin: [0, 8, 0, 0] },
        ]
      : [];

  const signBlock = (role: string, name: string): Content => ({
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW / 2 - 20, y2: 0, lineWidth: 1.2, lineColor: R.ink }] },
      { text: role, style: 'signRole', margin: [0, 8, 0, 0] },
      { text: name || ' ', style: 'signName', margin: [0, 2, 0, 0] },
      {
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: CW / 2 - 20, y2: 0, lineWidth: 0.75, lineColor: R.faint, dash: { length: 1.5, space: 2.5 } },
        ],
        margin: [0, 38, 0, 0],
      },
      { text: L.dateLine, style: 'smallMuted', margin: [0, 6, 0, 0] },
    ],
  });

  const signoffPage: Content[] = [
    ...phead(rate != null ? L.signoffFees : L.signoffPlain, ref),
    ...investBox,
    {
      text: L.declaration({
        client,
        ref,
        range,
        hours: h(totalSecs),
        fees: totalFee != null ? money(totalFee) : null,
      }),
      style: 'declare',
      margin: [0, rate != null ? 22 : 4, 0, 0],
    },
    {
      columns: [
        signBlock(L.preparedBy, [doc.personName, doc.role].filter(Boolean).join(' · ')),
        signBlock(L.approvedBy, doc.approver),
      ],
      columnGap: 40,
      margin: [0, 36, 0, 0],
    },
    {
      unbreakable: true,
      margin: [0, 30, 0, 0],
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                { text: L.basisTitle.toUpperCase(), style: 'basisTitle' },
                { text: L.basis, style: 'smallMuted', margin: [0, 5, 0, 0] },
              ],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.75,
        vLineWidth: () => 0.75,
        hLineColor: () => R.line,
        vLineColor: () => R.line,
        paddingTop: () => 10,
        paddingBottom: () => 10,
        paddingLeft: () => 12,
        paddingRight: () => 12,
      },
    },
  ];

  return {
    pageOrientation: 'portrait',
    pageSize: 'A4',
    pageMargins: [48, 48, 48, 60],
    info: { title: `${L.docTitle} — ${client}`.trim() },
    content: [...cover, ...summaryPage, ...detailPage, ...signoffPage],
    footer: (currentPage: number, pageCount: number): Content =>
      currentPage === 1
        ? { text: '' }
        : {
            margin: [48, 14, 48, 0],
            columns: [
              { text: `${doc.personName} · ${L.confidential}`.toUpperCase(), style: 'foot' },
              { text: ref, style: 'foot', alignment: 'center' },
              { text: L.page(currentPage, pageCount), style: 'footMono', alignment: 'right' },
            ],
          },
    styles: {
      glyph: { font: 'Fraunces', fontSize: 12, bold: true, color: R.ink, alignment: 'center' },
      brandName: { fontSize: 10.5, bold: true, color: R.ink },
      brandRole: { fontSize: 6.6, color: R.muted, characterSpacing: 1.2 },
      chip: { fontSize: 7, color: R.muted, characterSpacing: 1.6 },
      doctype: { fontSize: 8, bold: true, color: R.ochre, characterSpacing: 2.4 },
      coverTitle: { font: 'Fraunces', fontSize: 33, color: R.ink, lineHeight: 1.05 },
      coverSub: { font: 'Fraunces', fontSize: 13.5, italics: true, color: R.ink2 },
      metaK: { fontSize: 6.6, color: R.muted, characterSpacing: 1.3 },
      metaV: { fontSize: 10, bold: true, color: R.ink, margin: [0, 3, 0, 0] },
      metaVSerif: { font: 'Fraunces', fontSize: 12, color: R.ink, margin: [0, 3, 0, 0] },
      metaVMono: { font: 'IBMPlexMono', fontSize: 9.5, bold: true, color: R.ink, margin: [0, 3, 0, 0] },
      pheadTitle: { font: 'Fraunces', fontSize: 17, color: R.ink },
      pheadNote: { fontSize: 7, color: R.muted, characterSpacing: 1.4 },
      sectionH: { fontSize: 7.4, bold: true, color: R.accent, characterSpacing: 1.5 },
      lead: { font: 'Fraunces', fontSize: 11, color: R.ink2, lineHeight: 1.35 },
      kpiK: { fontSize: 6.4, color: R.muted, characterSpacing: 1 },
      kpiV: { font: 'IBMPlexMono', fontSize: 16, color: R.ink },
      kpiVSmall: { font: 'IBMPlexMono', fontSize: 11, color: R.ink },
      kpiVUnit: { font: 'IBMPlexMono', fontSize: 9, color: R.muted },
      kpiD: { fontSize: 7, color: R.muted },
      th: { fontSize: 6.6, bold: true, color: R.muted, characterSpacing: 0.8 },
      td: { fontSize: 8.4, color: R.ink },
      tdMuted: { fontSize: 8.4, color: R.muted },
      tdMono: { font: 'IBMPlexMono', fontSize: 8, color: R.ink },
      tdMonoMuted: { font: 'IBMPlexMono', fontSize: 8, color: R.muted },
      tdNum: { font: 'IBMPlexMono', fontSize: 8.4, color: R.ink },
      dayHdr: { fontSize: 7.4, bold: true, color: R.ink2, characterSpacing: 0.8 },
      dayHdrNum: { font: 'IBMPlexMono', fontSize: 8, bold: true, color: R.ink2 },
      totalTd: { fontSize: 8.8, bold: true, color: R.ink },
      totalTdNum: { font: 'IBMPlexMono', fontSize: 8.8, bold: true, color: R.ink },
      investTotal: { fontSize: 9, bold: true, color: R.paper },
      investTotalNum: { font: 'IBMPlexMono', fontSize: 9, bold: true, color: R.paper },
      declare: { font: 'Fraunces', fontSize: 11, color: R.ink2, lineHeight: 1.45 },
      signRole: { fontSize: 9.2, bold: true, color: R.ink },
      signName: { fontSize: 8.2, color: R.muted },
      basisTitle: { fontSize: 7, bold: true, color: R.muted, characterSpacing: 1.5 },
      smallMuted: { fontSize: 7.6, color: R.muted, lineHeight: 1.4 },
      foot: { fontSize: 6.6, color: R.muted, characterSpacing: 1 },
      footMono: { font: 'IBMPlexMono', fontSize: 7, color: R.muted },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: R.ink },
  };
}

// Registered as two entries so the language reads directly in the template picker.
export const reportTemplates: PdfTemplate[] = [
  {
    id: 'report-en',
    name: 'Timesheet Report (EN)',
    description:
      'A multi-page report in English: cover, summary with totals by project and billing ' +
      'code, a day-by-day log, and a sign-off page. Add an hourly rate to include fees.',
    fields: ['role', 'company', 'client', 'approver', 'rate'],
    fontset: 'report',
    build: (doc) => buildReport(doc, 'en'),
  },
  {
    id: 'report-cs',
    name: 'Výkaz práce (CZ)',
    description:
      'Vícestránkový výkaz v češtině: titulní strana, souhrn podle projektů a účtovacích ' +
      'kódů, denní rozpis a strana pro schválení. Po zadání hodinové sazby doplní i odměnu.',
    fields: ['role', 'company', 'client', 'approver', 'rate'],
    fontset: 'report',
    build: (doc) => buildReport(doc, 'cs'),
  },
];

