// PDF templates for timesheet exports. A template turns an export document into a
// pdfmake document definition. The registry below is the extension point: add a new
// entry to offer another layout in the export dialog — the rest of the pipeline is
// template-agnostic.
//
// Every template follows the visual-identity design system (see ./identity),
// except the "(Green)" acceptance protocols, which deliberately keep the
// original spreadsheet-green design for clients whose workflow expects it.

import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import {
  type ExportDoc,
  type SummaryDoc,
  type IndividualDoc,
  secsToHoursLabel,
} from '../model';
import { reportTemplates } from './report';
import { buildAcceptanceGreen } from './acceptanceGreen';
import { buildAcceptanceIdentity } from './acceptanceIdentity';
import {
  VZ,
  A4_MARGINS,
  CW_PORTRAIT,
  CW_LANDSCAPE,
  principalRule,
  signature,
  ruledTableLayout,
  identityFooter,
  identityBaseStyles,
  identityDefaultStyle,
} from './identity';

export interface PdfTemplate {
  id: string;
  name: string;
  description: string;
  /**
   * Extra identity fields this template prints (beyond the person's name). The
   * export dialog shows an input for each — their values are user-entered, never
   * shipped with the app. 'rate' renders as a rate + currency pair with a
   * switch for what the rate is quoted per (an hour, or a man-day).
   */
  fields?: Array<
    'role' | 'company' | 'client' | 'approver' | 'reference' | 'engagement' | 'rate'
  >;
  /**
   * Language the template prints in. The export dialog uses it for the fields
   * the user must phrase themselves (the engagement note), so each language
   * keeps its own text rather than one being pasted into the other.
   */
  locale?: 'en' | 'cs';
  /**
   * Extra embedded fonts the template's styles reference. 'identity' pulls in
   * the IBM Plex Sans cuts (lazy-loaded next to pdfmake itself).
   */
  fontset?: 'identity';
  build: (doc: ExportDoc) => TDocumentDefinitions;
}

// ---- the standard template (identity design) ----

const hoursOrDash = (seconds: number): string => (seconds > 0 ? secsToHoursLabel(seconds) : '—');

// Fixed en-GB date conventions, matching the EN report — the model's labels
// follow the device locale, which must not leak into the document.
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtDayEn = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS_EN[d.getMonth()]}`;
};

/** "1 Jul – 31 Jul 2026" — the same range form the EN report prints. */
function fmtRangeEn(fromMs: number, toMs: number): string {
  const last = toMs - 1; // toMs is exclusive
  return `${fmtDayEn(fromMs)} – ${fmtDayEn(last)} ${new Date(last).getFullYear()}`;
}

/** "Tue 07 Jul" — the EN report's day-header form, without the year. */
function fmtDayHeadEn(ms: number): string {
  const d = new Date(ms);
  return `${DAYS_EN[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MONTHS_EN[d.getMonth()]}`;
}

/**
 * Document masthead: principal double rule with the page's one oxide
 * termination, the document title, and the person's name in signature form.
 */
function masthead(doc: ExportDoc): Content[] {
  return [
    principalRule(198, true, [0, 0, 0, 10]),
    {
      columns: [
        // The document type leads the title, so a continuation reader — or a
        // client filing several PDFs — sees what the document is at once.
        { text: doc.title ? `Timesheet · ${doc.title}` : 'Timesheet', style: 'vzDocTitle' },
        signature(doc.personName, { style: 'vzSignature', alignment: 'right', margin: [0, 6, 0, 0] }),
      ],
    },
    {
      stack: [
        { text: 'Period', style: 'vzMetaK' },
        { text: fmtRangeEn(doc.fromMs, doc.toMs), style: 'vzMetaV', margin: [0, 1, 0, 0] },
      ],
      margin: [0, 8, 0, 6],
    },
  ];
}

/**
 * The period total: label in SemiBold Ink, the value as the document's one
 * oxide figure over the classic double underline (§14 of the design spec).
 */
function grandTotal(label: string, seconds: number): Content {
  return {
    text: [
      { text: `${label}   `, style: 'vzTotal' },
      { text: secsToHoursLabel(seconds), style: 'vzGrandValue' },
    ],
    alignment: 'right',
    margin: [0, 14, 0, 0],
  };
}

// ---- summary ----

function summaryContent(doc: SummaryDoc): Content[] {
  const content: Content[] = [];
  for (const week of doc.weeks) {
    const weekLabel = `${fmtDayEn(week.dayDates[0])} – ${fmtDayEn(week.dayDates[week.dayDates.length - 1])}`;
    content.push({ text: weekLabel, style: 'weekHead' });

    const head: TableCell[] = [
      { text: 'Billing tag', style: 'vzTh' },
      ...week.dayLabels.map((d) => ({ text: d, style: 'vzTh', alignment: 'center' as const })),
      { text: 'Total', style: 'vzTh', alignment: 'center' as const },
      { text: 'Description', style: 'vzTh' },
    ];
    const body: TableCell[][] = [head];
    for (const r of week.rows) {
      const style = r.warn ? 'tdWarn' : 'vzTd';
      body.push([
        { text: r.label, style },
        ...r.cells.map((c) => ({ text: hoursOrDash(c), style, alignment: 'center' as const })),
        { text: hoursOrDash(r.total), style, alignment: 'center' as const },
        { text: r.desc, style },
      ]);
    }
    body.push([
      { text: 'Total', style: 'vzTotal' },
      ...week.dayTotals.map((c) => ({ text: hoursOrDash(c), style: 'vzTotal', alignment: 'center' as const })),
      { text: hoursOrDash(week.grandTotal), style: 'vzTotal', alignment: 'center' as const },
      { text: '', style: 'vzTotal' },
    ]);

    const dayWidths = week.dayLabels.map(() => 'auto' as const);
    content.push({
      table: { headerRows: 1, widths: ['auto', ...dayWidths, 'auto', '*'], body },
      layout: ruledTableLayout({ totalRow: true }),
    });
  }
  content.push(grandTotal('Grand total', doc.grandTotal));
  return content;
}

// ---- individual ----

function individualContent(doc: IndividualDoc): Content[] {
  const content: Content[] = [];
  for (const day of doc.days) {
    content.push({
      columns: [
        { text: fmtDayHeadEn(day.dateMs), style: 'dayHead' },
        { text: secsToHoursLabel(day.total), style: 'dayHead', alignment: 'right' },
      ],
    });

    const head: TableCell[] = [
      { text: 'Time', style: 'vzTh' },
      { text: 'Hours', style: 'vzTh', alignment: 'center' },
      { text: 'Billing', style: 'vzTh' },
      { text: 'Description', style: 'vzTh' },
    ];
    const body: TableCell[][] = [head];
    for (const r of day.rows) {
      const style = r.warn ? 'tdWarn' : 'vzTd';
      body.push([
        { text: r.time ?? '—', style },
        { text: hoursOrDash(r.hours), style, alignment: 'center' },
        { text: r.code, style },
        { text: r.desc, style },
      ]);
    }
    content.push({
      // A fixed Time column: an 'auto' column may be squeezed by a long
      // description and wrap a clock time mid-figure.
      table: { headerRows: 1, widths: [64, 'auto', 'auto', '*'], body },
      layout: ruledTableLayout(),
    });
  }
  content.push(grandTotal('Grand total', doc.grandTotal));
  return content;
}

function buildStandard(doc: ExportDoc): TDocumentDefinitions {
  const generatedAt = Date.now();
  const content: Content[] = [...masthead(doc)];
  if (doc.view === 'summary') content.push(...summaryContent(doc));
  else content.push(...individualContent(doc));

  const landscape = doc.view === 'summary';
  const gen = new Date(generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const title = doc.title ? `Timesheet · ${doc.title}` : 'Timesheet';
  const period = fmtRangeEn(doc.fromMs, doc.toMs);

  return {
    // Summary grids are wide, so they print landscape; the individual list is portrait.
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageSize: 'A4',
    pageMargins: A4_MARGINS,
    info: {
      title: `Timesheet — ${doc.title || ''}`.trim(),
      author: doc.personName || undefined,
      subject: 'Timesheet',
    },
    // Continuation pages repeat the document context and authorship — a
    // separated page 2 should still say whose sheet it is and for what period.
    header: (currentPage: number): Content =>
      currentPage === 1
        ? { text: '' }
        : {
            margin: [62, 26, 62, 0],
            columns: [
              { text: `${title} — ${period}`, style: 'vzContHead' },
              signature(doc.personName, { style: 'vzContHead', alignment: 'right' }),
            ],
          },
    content,
    styles: {
      ...identityBaseStyles,
      weekHead: { fontSize: 9.5, bold: true, color: VZ.ink, margin: [0, 12, 0, 5] },
      dayHead: { fontSize: 9.5, bold: true, color: VZ.ink, margin: [0, 10, 0, 4] },
      vzTotal: { fontSize: 8.5, bold: true, color: VZ.ink },
      vzContHead: { fontSize: 7.5, color: VZ.secondary },
      vzGrandValue: {
        fontSize: 10,
        bold: true,
        color: VZ.oxide,
        decoration: 'underline',
        decorationStyle: 'double',
        decorationColor: VZ.ink,
      },
      // Utility warning tone for rows the on-screen view flags; deliberately a
      // non-identity colour (the identity accent never signals errors).
      tdWarn: { fontSize: 8.5, color: '#b45309' },
    },
    defaultStyle: { ...identityDefaultStyle, fontSize: 8.5 },
    footer: identityFooter(landscape ? CW_LANDSCAPE : CW_PORTRAIT, `Generated ${gen}`),
  };
}

// ---- the registry ----

export const PDF_TEMPLATES: PdfTemplate[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Clean timesheet with your name, period and per-week (or per-day) tables.',
    fontset: 'identity',
    build: buildStandard,
  },
  {
    // The id stays 'acceptance-protocol' so a previously picked template keeps
    // resolving; only the displayed name gained the "(Full)" suffix.
    id: 'acceptance-protocol',
    name: 'Timesheet Acceptance Protocol (Full)',
    description:
      'Formal per-day sheet: name/role/company header, a row for every calendar day ' +
      '(hours and man-days, 8h = 1 MD), and a signature area for digital approval. ' +
      'Each day lists every entry description in full.',
    fields: ['role', 'company'],
    fontset: 'identity',
    build: (doc) => buildAcceptanceIdentity(doc, 'full'),
  },
  {
    id: 'acceptance-protocol-compact',
    name: 'Timesheet Acceptance Protocol (Compact)',
    description:
      'The same per-day sheet, but each day is one line: every billing code ' +
      '(ordered by hours) and a single overall description of the day — no ' +
      'per-entry times. Daily hours and man-days are identical to the Full variant.',
    fields: ['role', 'company'],
    fontset: 'identity',
    build: (doc) => buildAcceptanceIdentity(doc, 'compact'),
  },
  {
    id: 'acceptance-protocol-green',
    name: 'Timesheet Acceptance Protocol (Green, Full)',
    description:
      'The Full acceptance protocol in its original spreadsheet-green design — ' +
      'same rows and figures, the familiar olive look.',
    fields: ['role', 'company'],
    build: (doc) => buildAcceptanceGreen(doc, 'full'),
  },
  {
    id: 'acceptance-protocol-green-compact',
    name: 'Timesheet Acceptance Protocol (Green, Compact)',
    description:
      'The Compact acceptance protocol in its original spreadsheet-green design — ' +
      'same rows and figures, the familiar olive look.',
    fields: ['role', 'company'],
    build: (doc) => buildAcceptanceGreen(doc, 'compact'),
  },
  ...reportTemplates,
];

export const DEFAULT_TEMPLATE_ID = PDF_TEMPLATES[0].id;

export function getTemplate(id: string): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === id) ?? PDF_TEMPLATES[0];
}
