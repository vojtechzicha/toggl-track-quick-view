// The Timesheet template — the app's own PDF layout, and the one every clone
// of this repository gets.
//
// It prints what the screen shows: the per-week grid in Summary view, the
// per-day list in Individual view, under a plain masthead carrying the title,
// the person and the period. Deliberately neutral: no logo, no accent colour,
// no embedded typeface. It renders in pdfmake's bundled Roboto, so it adds
// nothing to the export bundle and needs no font plumbing — the price is
// Roboto's character map (Latin and Latin Extended, so Czech diacritics are
// fine; Cyrillic and Greek are not). A template that has to set text in
// another script embeds its own cuts through `loadFonts` (see ./types).
//
// This file is also the worked example the README points at for writing one.

import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import {
  type ExportDoc,
  type SummaryDoc,
  type IndividualDoc,
  secsToHoursLabel,
} from '../model';
import type { PdfTemplate } from './types';

// ---- the small palette ----

const INK = '#1F2328';
const MUTED = '#6B7280';
const RULE = '#D6D9DE';
const SURFACE = '#F3F4F6';
/** Rows the on-screen view flags (untagged / multi-tagged entries). */
const WARN = '#B45309';

/** A4 margins, in points: ~17 mm sides, 20 mm top, 18 mm bottom (footer room). */
const MARGINS: [number, number, number, number] = [48, 56, 48, 56];
const CW_PORTRAIT = 595.28 - 2 * 48;
const CW_LANDSCAPE = 841.89 - 2 * 48;

// Fixed en-GB date conventions. The model's own labels follow the DEVICE
// locale, which must not leak into a document that will be filed by someone
// else — two exports of the same month should not read differently because
// they were made on differently configured laptops.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const hoursOrDash = (seconds: number): string => (seconds > 0 ? secsToHoursLabel(seconds) : '—');

const fmtDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** "1 Jul – 31 Jul 2026". `toMs` is exclusive, so the last day is the tick before. */
function fmtRange(fromMs: number, toMs: number): string {
  const last = toMs - 1;
  return `${fmtDay(fromMs)} – ${fmtDay(last)} ${new Date(last).getFullYear()}`;
}

/** "Tue 07 Jul" — the day-header form, without the year. */
function fmtDayHead(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

const docTitle = (doc: ExportDoc): string => (doc.title ? `Timesheet · ${doc.title}` : 'Timesheet');

// ---- shared furniture ----

/** A plain rule across the given width. */
function rule(width: number, weight: number, color: string, margin: [number, number, number, number]): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: weight / 2, x2: width, y2: weight / 2, lineWidth: weight, lineColor: color }],
    margin,
  };
}

/**
 * The table look, shared by both views: a rule above and below the head, a
 * hairline between rows, a closing rule, no vertical lines and no zebra —
 * figures read better against white than against alternating bands.
 */
function tableLayout(opts: { totalRow?: boolean } = {}) {
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) => {
      const last = node.table.body.length;
      if (i === 0 || i === 1 || i === last) return 0.8;
      if (opts.totalRow && i === last - 1) return 0.8;
      return 0.3;
    },
    hLineColor: (i: number, node: { table: { body: unknown[] } }) => {
      const last = node.table.body.length;
      return i === 0 || i === 1 || i === last || (opts.totalRow && i === last - 1) ? INK : RULE;
    },
    vLineWidth: () => 0,
    fillColor: (rowIndex: number) => (rowIndex === 0 ? SURFACE : null),
    paddingTop: () => 3.5,
    paddingBottom: () => 3.5,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

/** Title, person and period — page 1 only; page 2 onward gets the running head. */
function masthead(doc: ExportDoc, width: number): Content[] {
  return [
    {
      columns: [
        { text: docTitle(doc), style: 'title' },
        { text: doc.personName, style: 'person', alignment: 'right' },
      ],
    },
    rule(width, 0.8, INK, [0, 4, 0, 0]),
    {
      columns: [
        { text: 'Period', style: 'metaKey' },
        { text: fmtRange(doc.fromMs, doc.toMs), style: 'metaValue', alignment: 'right' },
      ],
      margin: [0, 6, 0, 10],
    },
  ];
}

/** The period total, right-aligned under the last table. */
function grandTotal(seconds: number): Content {
  return {
    text: [
      { text: 'Grand total   ', style: 'total' },
      { text: secsToHoursLabel(seconds), style: 'grandValue' },
    ],
    alignment: 'right',
    margin: [0, 12, 0, 0],
  };
}

// ---- summary view: one grid per week ----

function summaryContent(doc: SummaryDoc): Content[] {
  const content: Content[] = [];
  for (const week of doc.weeks) {
    const first = week.dayDates[0];
    const last = week.dayDates[week.dayDates.length - 1];
    content.push({ text: `${fmtDay(first)} – ${fmtDay(last)}`, style: 'sectionHead' });

    const body: TableCell[][] = [
      [
        // A workspace that bills by project has project names in this column.
        { text: doc.billByProject ? 'Project' : 'Billing tag', style: 'th' },
        ...week.dayLabels.map((d) => ({ text: d, style: 'th', alignment: 'center' as const })),
        { text: 'Total', style: 'th', alignment: 'center' as const },
        { text: 'Description', style: 'th' },
      ],
    ];
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
      { text: 'Total', style: 'total' },
      ...week.dayTotals.map((c) => ({ text: hoursOrDash(c), style: 'total', alignment: 'center' as const })),
      { text: hoursOrDash(week.grandTotal), style: 'total', alignment: 'center' as const },
      { text: '', style: 'total' },
    ]);

    content.push({
      table: {
        headerRows: 1,
        widths: ['auto', ...week.dayLabels.map(() => 'auto' as const), 'auto', '*'],
        body,
      },
      layout: tableLayout({ totalRow: true }),
    });
  }
  content.push(grandTotal(doc.grandTotal));
  return content;
}

// ---- individual view: one table per day ----

function individualContent(doc: IndividualDoc): Content[] {
  const content: Content[] = [];
  for (const day of doc.days) {
    content.push({
      columns: [
        { text: fmtDayHead(day.dateMs), style: 'sectionHead' },
        { text: secsToHoursLabel(day.total), style: 'sectionHead', alignment: 'right' },
      ],
    });

    const body: TableCell[][] = [
      [
        { text: 'Time', style: 'th' },
        { text: 'Hours', style: 'th', alignment: 'center' },
        { text: doc.billByProject ? 'Project' : 'Billing', style: 'th' },
        { text: 'Description', style: 'th' },
      ],
    ];
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
      // A fixed Time column: an 'auto' column may be squeezed by a long
      // description and wrap a clock time mid-figure.
      table: { headerRows: 1, widths: [64, 'auto', 'auto', '*'], body },
      layout: tableLayout(),
    });
  }
  content.push(grandTotal(doc.grandTotal));
  return content;
}

// ---- the document ----

function buildTimesheet(doc: ExportDoc): TDocumentDefinitions {
  // Summary grids are wide, so they print landscape; the individual list is portrait.
  const landscape = doc.view === 'summary';
  const width = landscape ? CW_LANDSCAPE : CW_PORTRAIT;

  const content: Content[] = [...masthead(doc, width)];
  if (doc.view === 'summary') content.push(...summaryContent(doc));
  else content.push(...individualContent(doc));

  const generated = new Date().toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const running = `${docTitle(doc)} — ${fmtRange(doc.fromMs, doc.toMs)}`;

  return {
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageSize: 'A4',
    pageMargins: MARGINS,
    language: 'en-GB',
    info: {
      title: `Timesheet — ${doc.title || ''}`.trim(),
      author: doc.personName || undefined,
      subject: 'Timesheet',
    },
    // Continuation pages repeat the document context and authorship — a page 2
    // separated from page 1 should still say whose sheet it is, and for what.
    header: (currentPage: number): Content =>
      currentPage === 1
        ? { text: '' }
        : {
            margin: [48, 24, 48, 0],
            columns: [
              { text: running, style: 'runningHead' },
              { text: doc.personName, style: 'runningHead', alignment: 'right' },
            ],
          },
    content,
    footer: (currentPage: number, pageCount: number): Content => ({
      margin: [48, 12, 48, 0],
      stack: [
        rule(width, 0.3, RULE, [0, 0, 0, 4]),
        {
          columns: [
            { text: `Generated ${generated}`, style: 'footer' },
            { text: `${currentPage}/${pageCount}`, style: 'footer', alignment: 'right' },
          ],
        },
      ],
    }),
    styles: {
      title: { fontSize: 14, bold: true, color: INK },
      person: { fontSize: 9, bold: true, color: INK, margin: [0, 5, 0, 0] },
      metaKey: { fontSize: 7.5, color: MUTED },
      metaValue: { fontSize: 7.5, bold: true, color: INK },
      sectionHead: { fontSize: 9.5, bold: true, color: INK, margin: [0, 12, 0, 4] },
      th: { fontSize: 7, bold: true, color: MUTED },
      td: { fontSize: 8.5, color: INK },
      tdWarn: { fontSize: 8.5, color: WARN },
      total: { fontSize: 8.5, bold: true, color: INK },
      grandValue: { fontSize: 10, bold: true, color: INK, decoration: 'underline' },
      runningHead: { fontSize: 7.5, color: MUTED },
      footer: { fontSize: 6.5, color: MUTED },
    },
    defaultStyle: { fontSize: 8.5, color: INK },
  };
}

export const timesheetTemplate: PdfTemplate = {
  id: 'timesheet',
  name: 'Timesheet',
  description:
    'Your name, the period, and the per-week (Summary) or per-day (Individual) tables ' +
    'exactly as shown on screen.',
  build: buildTimesheet,
};
