// PDF templates for timesheet exports. A template turns an export document into a
// pdfmake document definition. The registry below is the extension point: add a new
// entry to offer another layout in the export dialog — the rest of the pipeline is
// template-agnostic.

import type { TDocumentDefinitions, Content, ContentTable, TableCell } from 'pdfmake/interfaces';
import {
  type ExportDoc,
  type SummaryDoc,
  type IndividualDoc,
  periodLabel,
  secsToHoursLabel,
} from '../model';
import { weeksInRange } from '../range';
import { DAY_MS } from '@/lib/timesheet/constants';
import { reportTemplates } from './report';
import { allocateMd, HOURS_PER_MD } from './money';
import { compactDayText, fixDescTypos, type CompactRow } from './acceptanceCompact';

/**
 * Where a signable template puts its signature widget.
 *
 * The rectangle is in pdfmake's coordinates — points from the page's TOP-left
 * corner — and is guaranteed to be free on the document's LAST page. The
 * signing stage converts it to the PDF's bottom-left origin against the page it
 * actually finds (see lib/export/pdf/sign/widget.ts).
 *
 * This exists because the finished blob carries no metadata about where a
 * flowing signature block landed: its page and Y vary with the number of table
 * rows. So the template does not report a position, it *guarantees* one — see
 * signatureBlock() for the two halves of that guarantee.
 */
export interface SignatureWidget {
  rect: { x: number; y: number; width: number; height: number };
  /** Page size the rect is expressed against; a mismatch means a wrong contract. */
  page: { width: number; height: number };
}

export interface PdfTemplate {
  id: string;
  name: string;
  description: string;
  /**
   * Extra identity fields this template prints (beyond the person's name). The
   * export dialog shows an input for each — their values are user-entered, never
   * shipped with the app. 'rate' renders as an hourly rate + currency pair.
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
   * Extra embedded fonts the template's styles reference. 'report' pulls in the
   * Fraunces / IBM Plex Mono cuts (lazy-loaded next to pdfmake itself).
   */
  fontset?: 'report';
  /**
   * Present when the template reserves a signature area — the only templates
   * that can be digitally signed. Absent = the export dialog offers no signing.
   */
  signatureWidget?: SignatureWidget;
  build: (doc: ExportDoc) => TDocumentDefinitions;
}

// ---- shared bits ----

const COLOR = {
  text: '#1f2937',
  muted: '#6b7280',
  heading: '#111827',
  accent: '#2563eb',
  warn: '#b45309',
  line: '#e5e7eb',
  headFill: '#f3f4f6',
};

const hoursOrDash = (seconds: number): string => (seconds > 0 ? secsToHoursLabel(seconds) : '—');

function headerStack(doc: ExportDoc): Content {
  const bits: Content[] = [{ text: doc.title || 'Timesheet', style: 'title' }];
  if (doc.personName) bits.push({ text: doc.personName, style: 'person' });
  bits.push({ text: periodLabel(doc.fromMs, doc.toMs), style: 'period' });
  return { stack: bits, margin: [0, 0, 0, 14] };
}

function pageFooter(generatedAt: number, note?: string) {
  const gen = new Date(generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const left = note ? `Generated ${gen} · ${note}` : `Generated ${gen}`;
  return (currentPage: number, pageCount: number): Content => ({
    margin: [40, 0, 40, 0],
    columns: [
      { text: left, style: 'footer', alignment: 'left' },
      { text: `${currentPage} / ${pageCount}`, style: 'footer', alignment: 'right' },
    ],
  });
}

const baseStyles: TDocumentDefinitions['styles'] = {
  title: { fontSize: 18, bold: true, color: COLOR.heading },
  person: { fontSize: 12, color: COLOR.text, margin: [0, 2, 0, 0] },
  period: { fontSize: 10, color: COLOR.muted, margin: [0, 2, 0, 0] },
  weekHead: { fontSize: 12, bold: true, color: COLOR.accent, margin: [0, 10, 0, 4] },
  dayHead: { fontSize: 11, bold: true, color: COLOR.heading, margin: [0, 8, 0, 3] },
  th: { fontSize: 9, bold: true, color: COLOR.heading },
  td: { fontSize: 9, color: COLOR.text },
  tdWarn: { fontSize: 9, color: COLOR.warn },
  totalRow: { fontSize: 9, bold: true, color: COLOR.heading },
  footer: { fontSize: 8, color: COLOR.muted },
};

const tableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => COLOR.line,
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

// ---- summary ----

function summaryContent(doc: SummaryDoc): Content[] {
  const content: Content[] = [];
  for (const week of doc.weeks) {
    content.push({ text: week.label, style: 'weekHead' });

    const head: TableCell[] = [
      { text: 'Billing tag', style: 'th' },
      ...week.dayLabels.map((d) => ({ text: d, style: 'th', alignment: 'center' as const })),
      { text: 'Total', style: 'th', alignment: 'center' as const },
      { text: 'Description', style: 'th' },
    ];
    const body: TableCell[][] = [head];
    for (const r of week.rows) {
      const style = r.warn ? 'tdWarn' : 'td';
      body.push([
        { text: r.label, style },
        ...r.cells.map((c) => ({ text: hoursOrDash(c), style, alignment: 'center' as const })),
        { text: hoursOrDash(r.total), style, alignment: 'center' as const },
        { text: r.desc, style },
      ]);
    }
    body.push([
      { text: 'Total', style: 'totalRow' },
      ...week.dayTotals.map((c) => ({ text: hoursOrDash(c), style: 'totalRow', alignment: 'center' as const })),
      { text: hoursOrDash(week.grandTotal), style: 'totalRow', alignment: 'center' as const },
      { text: '', style: 'totalRow' },
    ]);

    const dayWidths = week.dayLabels.map(() => 'auto' as const);
    content.push({
      table: { headerRows: 1, widths: ['auto', ...dayWidths, 'auto', '*'], body },
      layout: { ...tableLayout, fillColor: (rowIndex: number) => (rowIndex === 0 ? COLOR.headFill : null) },
    });
  }
  content.push({
    text: `Grand total: ${secsToHoursLabel(doc.grandTotal)}`,
    style: 'weekHead',
    alignment: 'right',
  });
  return content;
}

// ---- individual ----

function individualContent(doc: IndividualDoc): Content[] {
  const content: Content[] = [];
  for (const day of doc.days) {
    content.push({
      columns: [
        { text: day.label, style: 'dayHead' },
        { text: secsToHoursLabel(day.total), style: 'dayHead', alignment: 'right' },
      ],
    });

    const head: TableCell[] = [
      { text: 'Time', style: 'th' },
      { text: 'Hours', style: 'th', alignment: 'center' },
      { text: 'Billing', style: 'th' },
      { text: 'Description', style: 'th' },
    ];
    const body: TableCell[][] = [head];
    for (const r of day.rows) {
      const style = r.warn ? 'tdWarn' : 'td';
      body.push([
        { text: r.time ?? '—', style },
        { text: hoursOrDash(r.hours), style, alignment: 'center' },
        { text: r.code, style },
        { text: r.desc, style },
      ]);
    }
    content.push({
      table: { headerRows: 1, widths: ['auto', 'auto', 'auto', '*'], body },
      layout: { ...tableLayout, fillColor: (rowIndex: number) => (rowIndex === 0 ? COLOR.headFill : null) },
    });
  }
  content.push({
    text: `Grand total: ${secsToHoursLabel(doc.grandTotal)}`,
    style: 'dayHead',
    alignment: 'right',
    margin: [0, 10, 0, 0],
  });
  return content;
}

function buildStandard(doc: ExportDoc): TDocumentDefinitions {
  const generatedAt = Date.now();
  const content: Content[] = [headerStack(doc)];
  if (doc.view === 'summary') content.push(...summaryContent(doc));
  else content.push(...individualContent(doc));

  return {
    // Summary grids are wide, so they print landscape; the individual list is portrait.
    pageOrientation: doc.view === 'summary' ? 'landscape' : 'portrait',
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    info: { title: `Timesheet — ${doc.title || ''}`.trim() },
    content,
    styles: baseStyles,
    defaultStyle: { fontSize: 9, color: COLOR.text },
    footer: pageFooter(generatedAt),
  };
}

// ---- acceptance protocol ----

// The acceptance sheet is day-based regardless of view: one row per calendar day
// of the exported range (empty days included), a person/company header on top and
// a digital-signature area at the bottom. Man-days assume the common 8h day
// (HOURS_PER_MD, shared with the report templates).
//
// Two variants share the sheet. "full" lists every exported row of the day
// verbatim; "compact" renders the day as one line — every billing code, then a
// single overall description (see ./acceptanceCompact). The variants differ
// ONLY in the Project / Task cell text — the day's Hours and MD figures come
// from the same seconds either way.

type AcceptanceVariant = 'full' | 'compact';

const ACCEPT = {
  line: '#77933c', // olive border, as on typical spreadsheet-born protocols
  headFill: '#d8e4bc',
  zebraFill: '#f2f7e8',
  boxFill: '#ebf1de',
};

const fmtNum = (n: number): string => n.toFixed(2);
const secsToHoursNumLabel = (secs: number): string => fmtNum(secs / 3600);

/**
 * Per-day MD labels (2 dp) whose sum is exactly the period total's 2 dp value —
 * see `allocateMd`, which does the largest-remainder work.
 */
function mdColumn(daySecs: number[]): { rows: string[]; total: string } {
  const { rows, total } = allocateMd(daySecs);
  return { rows: rows.map(fmtNum), total: fmtNum(total) };
}
const fmtDayMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};
const fmtFullDate = (ms: number): string => `${fmtDayMonth(ms)}/${new Date(ms).getFullYear()}`;

/** ISO-8601 week number (weeks start Monday; week 1 contains the year's first Thursday). */
function isoWeek(ms: number): number {
  const d = new Date(ms);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // the week's Thursday
  const week1 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

interface DayAgg {
  seconds: number;
  tasks: string[]; // deduped "code - description" lines (or the one compact line)
  rows: CompactRow[]; // the day's exported rows, the compact aggregation's input
}

function pushTask(agg: DayAgg, code: string, desc: string): void {
  const fixed = fixDescTypos(desc);
  const text = code && fixed ? `${code} - ${fixed}` : code || fixed;
  if (!text) return;
  if (!agg.tasks.some((t) => t.toLowerCase() === text.toLowerCase())) agg.tasks.push(text);
}

/** Per-day totals and task texts, keyed by the day's ms (same keys the builders emit). */
function acceptanceDays(doc: ExportDoc, variant: AcceptanceVariant): Map<number, DayAgg> {
  const byDay = new Map<number, DayAgg>();
  const day = (ms: number): DayAgg => {
    let agg = byDay.get(ms);
    if (!agg) {
      agg = { seconds: 0, tasks: [], rows: [] };
      byDay.set(ms, agg);
    }
    return agg;
  };
  const push = (agg: DayAgg, code: string, billingCode: string, desc: string, seconds: number) => {
    if (variant === 'compact') agg.rows.push({ code, billingCode, desc, seconds });
    else pushTask(agg, code, desc);
  };
  if (doc.view === 'individual') {
    for (const d of doc.days) {
      const agg = day(d.dateMs);
      agg.seconds += d.total;
      for (const r of d.rows) push(agg, r.code, r.billingCode, r.desc, r.hours);
    }
  } else {
    for (const week of doc.weeks) {
      week.dayDates.forEach((dateMs, ci) => {
        if (week.dayTotals[ci] <= 0) return;
        const agg = day(dateMs);
        agg.seconds += week.dayTotals[ci];
        for (const row of week.rows) {
          if (row.cells[ci] > 0) {
            push(agg, row.label, row.billingCode, row.dayDescs[ci], row.cells[ci]);
          }
        }
      });
    }
  }
  if (variant === 'compact') {
    for (const agg of byDay.values()) {
      if (agg.rows.length > 0) agg.tasks = [compactDayText(agg.rows)];
    }
  }
  return byDay;
}

function buildAcceptance(doc: ExportDoc, variant: AcceptanceVariant): TDocumentDefinitions {
  const generatedAt = Date.now();
  const byDay = acceptanceDays(doc, variant);

  // Every calendar day of the range appears, worked or not — enumerated with the
  // same week+offset arithmetic the builders use, so the keys line up.
  const dayList: number[] = [];
  for (const ws of weeksInRange(doc.fromMs, doc.toMs)) {
    for (let d = 0; d < 7; d++) {
      const ms = ws + d * DAY_MS;
      if (ms >= doc.fromMs && ms < doc.toMs) dayList.push(ms);
    }
  }

  const md = mdColumn(dayList.map((ms) => byDay.get(ms)?.seconds ?? 0));
  const lastDayMs = doc.toMs - DAY_MS; // inclusive last day

  const infoRow = (label: string, value: string): TableCell[] => [
    { text: label, style: 'acceptLabel' },
    { text: value, style: 'acceptValue' },
  ];
  const infoBlock: Content = {
    table: {
      widths: [90, '*'],
      body: [
        infoRow('Name', doc.personName),
        infoRow('Role', doc.role),
        infoRow('Company', doc.company),
        infoRow('Start date', fmtFullDate(doc.fromMs)),
        infoRow('End date', fmtFullDate(lastDayMs)),
        infoRow('MDs', md.total),
      ],
    },
    layout: {
      // Outer box only — the inside reads as one form block, like the original.
      hLineWidth: (i: number, node: ContentTable) =>
        i === 0 || i === node.table.body.length ? 1 : 0,
      vLineWidth: (i: number) => (i === 0 || i === 2 ? 1 : 0), // 2 columns

      hLineColor: () => ACCEPT.line,
      vLineColor: () => ACCEPT.line,
      fillColor: () => ACCEPT.boxFill,
      paddingTop: () => 1.5,
      paddingBottom: () => 1.5,
      paddingLeft: () => 6,
      paddingRight: () => 6,
    },
    margin: [0, 0, 0, 16],
  };

  const head: TableCell[] = [
    { text: 'Year', style: 'acceptTh', alignment: 'center' },
    { text: 'Month', style: 'acceptTh', alignment: 'center' },
    { text: 'Week', style: 'acceptTh', alignment: 'center' },
    { text: 'Date', style: 'acceptTh', alignment: 'center' },
    { text: 'Company', style: 'acceptTh' },
    { text: 'Project / Task', style: 'acceptTh', alignment: 'center' },
    { text: 'Hours', style: 'acceptTh', alignment: 'center' },
    { text: 'MDs', style: 'acceptTh', alignment: 'center' },
  ];
  const body: TableCell[][] = [head];
  dayList.forEach((ms, di) => {
    const d = new Date(ms);
    const agg = byDay.get(ms);
    const secs = agg?.seconds ?? 0;
    body.push([
      { text: String(d.getFullYear()), style: 'acceptTd', alignment: 'center' },
      { text: String(d.getMonth() + 1), style: 'acceptTd', alignment: 'center' },
      { text: String(isoWeek(ms)), style: 'acceptTd', alignment: 'center' },
      { text: fmtDayMonth(ms), style: 'acceptTd', alignment: 'right' },
      { text: doc.company, style: 'acceptTd' },
      { text: agg?.tasks.join('; ') ?? '', style: 'acceptTd' },
      { text: secsToHoursNumLabel(secs), style: 'acceptTd', alignment: 'right' },
      { text: md.rows[di], style: 'acceptTd', alignment: 'right' },
    ]);
  });

  const dayTable: Content = {
    table: {
      headerRows: 1,
      widths: ['auto', 'auto', 'auto', 'auto', 'auto', '*', 'auto', 'auto'],
      body,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => ACCEPT.line,
      vLineColor: () => ACCEPT.line,
      fillColor: (rowIndex: number) =>
        rowIndex === 0 ? ACCEPT.headFill : rowIndex % 2 === 0 ? ACCEPT.zebraFill : null,
      paddingTop: () => 2.5,
      paddingBottom: () => 2.5,
      paddingLeft: () => 5,
      paddingRight: () => 5,
    },
  };

  // Reserved area for the signature — a labelled dashed box with room for a
  // signature widget's stamp, never a printed name.
  //
  // This box belongs to the APPROVER: the client countersigning the sheet, not
  // the person who produced it. So it stays ordinary flowing content and
  // declares no widget. The app signs as the ISSUER, and the issuer signs the
  // report templates — see REPORT_SIGNATURE_WIDGET in ./report.ts.
  const signatureBlock: Content = {
    unbreakable: true,
    margin: [0, 18, 0, 0],
    stack: [
      { text: 'Approved by (digital signature):', style: 'acceptSigLabel' },
      {
        canvas: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 280,
            h: 95,
            lineWidth: 0.75,
            lineColor: COLOR.muted,
            dash: { length: 4, space: 3 },
          },
        ],
        margin: [0, 6, 0, 0],
      },
    ],
  };

  return {
    pageOrientation: 'portrait',
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    info: { title: `Timesheet Acceptance Protocol — ${doc.title || ''}`.trim() },
    content: [
      { text: 'PROJECT EXTERNAL TIMESHEET', style: 'acceptTitle' },
      infoBlock,
      dayTable,
      signatureBlock,
    ],
    styles: {
      ...baseStyles,
      acceptTitle: { fontSize: 13, bold: true, color: COLOR.heading, margin: [0, 0, 0, 10] },
      acceptLabel: { fontSize: 9, bold: true, color: COLOR.heading, alignment: 'right' },
      acceptValue: { fontSize: 9, color: COLOR.text },
      acceptTh: { fontSize: 9, bold: true, color: COLOR.heading },
      acceptTd: { fontSize: 8.5, color: COLOR.text },
      acceptSigLabel: { fontSize: 9, color: COLOR.muted },
    },
    defaultStyle: { fontSize: 9, color: COLOR.text },
    footer: pageFooter(generatedAt, `MD = ${HOURS_PER_MD}hrs`),
  };
}

export const PDF_TEMPLATES: PdfTemplate[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Clean timesheet with your name, period and per-week (or per-day) tables.',
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
    build: (doc) => buildAcceptance(doc, 'full'),
  },
  {
    id: 'acceptance-protocol-compact',
    name: 'Timesheet Acceptance Protocol (Compact)',
    description:
      'The same per-day sheet, but each day is one line: every billing code ' +
      '(ordered by hours) and a single overall description of the day — no ' +
      'per-entry times. Daily hours and man-days are identical to the Full variant.',
    fields: ['role', 'company'],
    build: (doc) => buildAcceptance(doc, 'compact'),
  },
  ...reportTemplates,
];

export const DEFAULT_TEMPLATE_ID = PDF_TEMPLATES[0].id;

export function getTemplate(id: string): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === id) ?? PDF_TEMPLATES[0];
}
