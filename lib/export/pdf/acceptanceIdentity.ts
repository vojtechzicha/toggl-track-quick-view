// The Timesheet Acceptance Protocol in the visual-identity design (see
// ./identity). Same sheet as the original green form — one row per calendar
// day, an identity header, a digital-signature area — rendered in the identity
// grammar: IBM Plex Sans, the principal double rule with its oxide termination,
// hairline table rows, and the period's MD total as the document's one oxide
// value. Data shaping is shared with the green original (./acceptanceData), so
// the printed figures are identical between the two designs.

import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
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
import {
  VZ,
  A4_MARGINS,
  CW_PORTRAIT,
  principalRule,
  signature,
  ruledTableLayout,
  identityFooter,
  identityBaseStyles,
  identityDefaultStyle,
} from './identity';

export function buildAcceptanceIdentity(
  doc: ExportDoc,
  variant: AcceptanceVariant
): TDocumentDefinitions {
  const generatedAt = Date.now();
  const byDay = acceptanceDays(doc, variant);
  const dayList = calendarDays(doc);

  const md = mdColumn(dayList.map((ms) => byDay.get(ms)?.seconds ?? 0));
  const lastDayMs = doc.toMs - DAY_MS; // inclusive last day

  // Metadata as labelled pairs over hairline-separated rows — the metadata-block
  // grammar, not a filled form box. The period MD total is the document's one
  // oxide value; the names are factual here (the signature form signs the
  // masthead, not the form fields).
  const infoRow = (label: string, value: string, oxide = false): TableCell[] => [
    { text: label, style: 'vzMetaK', margin: [0, 1, 0, 0] },
    { text: value, style: oxide ? 'acceptMdTotal' : 'vzMetaV' },
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
        infoRow('MDs', md.total, true),
      ],
    },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
        i === 0 || i === node.table.body.length ? 0 : 0.3,
      hLineColor: () => VZ.rule,
      vLineWidth: () => 0,
      paddingTop: () => 3,
      paddingBottom: () => 3,
      paddingLeft: () => 0,
      paddingRight: () => 6,
    },
    margin: [0, 0, 0, 16],
  };

  const head: TableCell[] = [
    { text: 'Year', style: 'vzTh', alignment: 'center' },
    { text: 'Month', style: 'vzTh', alignment: 'center' },
    { text: 'Week', style: 'vzTh', alignment: 'center' },
    { text: 'Date', style: 'vzTh', alignment: 'center' },
    { text: 'Company', style: 'vzTh' },
    { text: 'Project / Task', style: 'vzTh' },
    { text: 'Hours', style: 'vzTh', alignment: 'right' },
    { text: 'MDs', style: 'vzTh', alignment: 'right' },
  ];
  const body: TableCell[][] = [head];
  dayList.forEach((ms, di) => {
    const d = new Date(ms);
    const agg = byDay.get(ms);
    const secs = agg?.seconds ?? 0;
    // A day without billable time stays on the sheet but recedes to Secondary,
    // so the worked days carry the page.
    const td = secs > 0 ? 'acceptTd' : 'acceptTdEmpty';
    body.push([
      { text: String(d.getFullYear()), style: td, alignment: 'center' },
      { text: String(d.getMonth() + 1), style: td, alignment: 'center' },
      { text: String(isoWeek(ms)), style: td, alignment: 'center' },
      { text: fmtDayMonth(ms), style: td, alignment: 'right' },
      { text: doc.company, style: td },
      { text: agg?.tasks.join('; ') ?? '', style: td },
      { text: secsToHoursNumLabel(secs), style: td, alignment: 'right' },
      { text: md.rows[di], style: td, alignment: 'right' },
    ]);
  });

  const dayTable: Content = {
    table: {
      headerRows: 1,
      widths: ['auto', 'auto', 'auto', 'auto', 'auto', '*', 'auto', 'auto'],
      body,
    },
    layout: ruledTableLayout(),
  };

  // Reserved area for the (digital) signature — a labelled dashed box with room
  // for a signature widget's name/date stamp, never a printed name.
  const signatureBlock: Content = {
    unbreakable: true,
    margin: [0, 20, 0, 0],
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
            lineWidth: 0.5,
            lineColor: VZ.secondary,
            dash: { length: 3, space: 3 },
          },
        ],
        margin: [0, 6, 0, 0],
      },
    ],
  };

  const gen = new Date(generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return {
    pageOrientation: 'portrait',
    pageSize: 'A4',
    pageMargins: A4_MARGINS,
    info: { title: `Timesheet Acceptance Protocol — ${doc.title || ''}`.trim() },
    content: [
      principalRule(198, true, [0, 0, 0, 10]),
      {
        columns: [
          { text: 'Timesheet acceptance protocol', style: 'vzDocTitle' },
          signature(doc.personName, { style: 'vzSignature', alignment: 'right', margin: [0, 6, 0, 0] }),
        ],
        margin: [0, 0, 0, 14],
      },
      infoBlock,
      dayTable,
      signatureBlock,
    ],
    styles: {
      ...identityBaseStyles,
      acceptTd: { fontSize: 8, color: VZ.ink },
      acceptTdEmpty: { fontSize: 8, color: VZ.secondary },
      acceptMdTotal: { fontSize: 8.5, bold: true, color: VZ.oxide },
      acceptSigLabel: { fontSize: 7.5, color: VZ.secondary },
    },
    defaultStyle: identityDefaultStyle,
    footer: identityFooter(CW_PORTRAIT, `Generated ${gen} · 1 MD = ${HOURS_PER_MD} h`),
  };
}
