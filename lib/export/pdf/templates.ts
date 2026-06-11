// PDF templates for timesheet exports. A template turns an export document into a
// pdfmake document definition. The registry below is the extension point: add a new
// entry to offer another layout in the export dialog — the rest of the pipeline is
// template-agnostic.

import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import {
  type ExportDoc,
  type SummaryDoc,
  type IndividualDoc,
  periodLabel,
  secsToHoursLabel,
} from '../model';

export interface PdfTemplate {
  id: string;
  name: string;
  description: string;
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

function pageFooter(generatedAt: number) {
  const gen = new Date(generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return (currentPage: number, pageCount: number): Content => ({
    margin: [40, 0, 40, 0],
    columns: [
      { text: `Generated ${gen}`, style: 'footer', alignment: 'left' },
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
  tdOvertime: { fontSize: 9, italics: true, color: COLOR.muted },
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
        { text: r.descs.join('; '), style },
      ]);
    }
    if (week.overtimeTotal > 0) {
      body.push([
        { text: 'Overtime (not billed)', style: 'tdOvertime' },
        ...week.overtimeCells.map((c) => ({
          text: c > 0 ? `−${secsToHoursLabel(c)}` : '—',
          style: 'tdOvertime',
          alignment: 'center' as const,
        })),
        { text: `−${secsToHoursLabel(week.overtimeTotal)}`, style: 'tdOvertime', alignment: 'center' as const },
        { text: '', style: 'tdOvertime' },
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
    for (const o of day.overlaps) {
      body.push([
        { text: '—', style: 'tdWarn' },
        { text: '—', style: 'tdWarn', alignment: 'center' },
        { text: 'Overlapping entries', style: 'tdWarn' },
        { text: o, style: 'tdWarn' },
      ]);
    }
    if (day.overtime > 0) {
      body.push([
        { text: '—', style: 'tdOvertime' },
        { text: `−${secsToHoursLabel(day.overtime)}`, style: 'tdOvertime', alignment: 'center' },
        { text: 'Overtime (not billed)', style: 'tdOvertime' },
        { text: '', style: 'tdOvertime' },
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

export const PDF_TEMPLATES: PdfTemplate[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Clean timesheet with your name, period and per-week (or per-day) tables.',
    build: buildStandard,
  },
];

export const DEFAULT_TEMPLATE_ID = PDF_TEMPLATES[0].id;

export function getTemplate(id: string): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === id) ?? PDF_TEMPLATES[0];
}
