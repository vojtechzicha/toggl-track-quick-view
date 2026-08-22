// The Timesheet Acceptance Protocol in its ORIGINAL design language — the
// olive-green, spreadsheet-born look the sheet had before the visual-identity
// redesign. Kept available (as the "(Green)" templates) for clients whose
// workflow expects the familiar form; the layout, palette and typography here
// are intentionally frozen. The identity-designed acceptance protocol lives in
// ./acceptanceIdentity.ts; both render the same data (see ./acceptanceData).

import type { TDocumentDefinitions, Content, ContentTable, TableCell } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';
import { HOURS_PER_MD } from './money';
import {
  type AcceptanceVariant,
  acceptanceDays,
  calendarDays,
  mdColumn,
  fmtDayMonth,
  fmtFullDate,
  isoWeek,
  secsToHoursNumLabel,
} from './acceptanceData';
import { DAY_MS } from '@/lib/timesheet/constants';

const COLOR = {
  text: '#1f2937',
  muted: '#6b7280',
  heading: '#111827',
};

const ACCEPT = {
  line: '#77933c', // olive border, as on typical spreadsheet-born protocols
  headFill: '#d8e4bc',
  zebraFill: '#f2f7e8',
  boxFill: '#ebf1de',
};

function pageFooter(generatedAt: number, note: string) {
  const gen = new Date(generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const left = `Generated ${gen} · ${note}`;
  return (currentPage: number, pageCount: number): Content => ({
    margin: [40, 0, 40, 0],
    columns: [
      { text: left, style: 'footer', alignment: 'left' },
      { text: `${currentPage} / ${pageCount}`, style: 'footer', alignment: 'right' },
    ],
  });
}

export function buildAcceptanceGreen(doc: ExportDoc, variant: AcceptanceVariant): TDocumentDefinitions {
  const generatedAt = Date.now();
  const byDay = acceptanceDays(doc, variant);
  const dayList = calendarDays(doc);

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

  // Reserved area for the (digital) signature — a labelled dashed box with room
  // for a signature widget's name/date stamp, never a printed name.
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
      acceptTitle: { fontSize: 13, bold: true, color: COLOR.heading, margin: [0, 0, 0, 10] },
      acceptLabel: { fontSize: 9, bold: true, color: COLOR.heading, alignment: 'right' },
      acceptValue: { fontSize: 9, color: COLOR.text },
      acceptTh: { fontSize: 9, bold: true, color: COLOR.heading },
      acceptTd: { fontSize: 8.5, color: COLOR.text },
      acceptSigLabel: { fontSize: 9, color: COLOR.muted },
      footer: { fontSize: 8, color: COLOR.muted },
    },
    defaultStyle: { fontSize: 9, color: COLOR.text },
    footer: pageFooter(generatedAt, `MD = ${HOURS_PER_MD}hrs`),
  };
}
