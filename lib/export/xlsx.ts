// XLSX serializer for an export document, built on SheetJS (lazy-loaded so the
// library only ships to the browser when an export actually runs). One worksheet:
// stacked week tables for the summary view, a flat entry table for the individual
// view. Hours are real numbers so the cells are sum-able in a spreadsheet.

import { type ExportDoc, periodLabel, secsToHoursNum } from './model';

type Cell = string | number | null;

function hoursCell(seconds: number): Cell {
  return seconds > 0 ? secsToHoursNum(seconds) : null;
}

function summaryAOA(doc: Extract<ExportDoc, { view: 'summary' }>): Cell[][] {
  const aoa: Cell[][] = [];
  aoa.push([doc.title || 'Timesheet']);
  if (doc.personName) aoa.push([doc.personName]);
  aoa.push([periodLabel(doc.fromMs, doc.toMs)]);
  aoa.push([]);
  for (const week of doc.weeks) {
    aoa.push([week.label]);
    aoa.push(['Billing tag', ...week.dayLabels, 'Total', 'Description']);
    for (const r of week.rows) {
      aoa.push([r.label, ...r.cells.map(hoursCell), secsToHoursNum(r.total), r.descs.join('; ')]);
    }
    aoa.push(['Total', ...week.dayTotals.map(hoursCell), secsToHoursNum(week.grandTotal), '']);
    aoa.push([]);
  }
  aoa.push(['Grand total', secsToHoursNum(doc.grandTotal)]);
  return aoa;
}

function individualAOA(doc: Extract<ExportDoc, { view: 'individual' }>): Cell[][] {
  const aoa: Cell[][] = [];
  aoa.push([doc.title || 'Timesheet']);
  if (doc.personName) aoa.push([doc.personName]);
  aoa.push([periodLabel(doc.fromMs, doc.toMs)]);
  aoa.push([]);
  aoa.push(['Date', 'Day', 'Time', 'Hours', 'Billing', 'Description']);
  for (const day of doc.days) {
    const [dayName, dateStr] = day.label.split(' · ');
    for (const r of day.rows) {
      aoa.push([dateStr ?? day.label, dayName ?? '', r.time ?? '', secsToHoursNum(r.hours), r.code, r.desc]);
    }
    for (const o of day.overlaps) {
      aoa.push([dateStr ?? day.label, dayName ?? '', '', null, 'Overlapping entries', o]);
    }
  }
  aoa.push([]);
  aoa.push(['Grand total', '', '', secsToHoursNum(doc.grandTotal)]);
  return aoa;
}

export async function toXLSX(doc: ExportDoc): Promise<Blob> {
  const XLSX = await import('xlsx');
  const aoa = doc.view === 'summary' ? summaryAOA(doc) : individualAOA(doc);
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Reasonable column widths: a wide first column and description column, the rest
  // narrow. (Width is in characters.)
  const colCount = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  ws['!cols'] = Array.from({ length: colCount }, (_, i) => {
    if (i === 0) return { wch: 22 };
    if (i === colCount - 1) return { wch: 48 };
    return { wch: 9 };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Timesheet');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
