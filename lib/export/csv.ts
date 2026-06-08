// CSV serializer for an export document. Plain and technical: hours as decimal
// numbers, one block per week (summary) or a flat row-per-entry table (individual).
// Blocks are separated by a blank line. Encoded with a UTF-8 BOM so Excel opens
// accented descriptions correctly.

import { type ExportDoc, periodLabel, secsToHoursNum } from './model';

/** Quote a CSV field when it contains a comma, quote, or newline. */
function esc(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: (string | number)[]): string {
  return cells.map(esc).join(',');
}

function hoursCell(seconds: number): string | number {
  return seconds > 0 ? secsToHoursNum(seconds) : '';
}

export function toCSV(doc: ExportDoc): string {
  const lines: string[] = [];
  const title = doc.title || 'Timesheet';
  lines.push(row([title]));
  if (doc.personName) lines.push(row([doc.personName]));
  lines.push(row([periodLabel(doc.fromMs, doc.toMs)]));
  lines.push('');

  if (doc.view === 'summary') {
    for (const week of doc.weeks) {
      lines.push(row([week.label]));
      lines.push(row(['Billing tag', ...week.dayLabels, 'Total', 'Description']));
      for (const r of week.rows) {
        lines.push(
          row([
            r.label,
            ...r.cells.map(hoursCell),
            secsToHoursNum(r.total),
            r.descs.join('; '),
          ])
        );
      }
      lines.push(
        row(['Total', ...week.dayTotals.map(hoursCell), secsToHoursNum(week.grandTotal), ''])
      );
      lines.push('');
    }
    lines.push(row(['Grand total', secsToHoursNum(doc.grandTotal)]));
  } else {
    lines.push(row(['Date', 'Day', 'Time', 'Hours', 'Billing', 'Description']));
    for (const day of doc.days) {
      const [dayName, dateStr] = day.label.split(' · ');
      for (const r of day.rows) {
        lines.push(
          row([dateStr ?? day.label, dayName ?? '', r.time ?? '', secsToHoursNum(r.hours), r.code, r.desc])
        );
      }
      for (const o of day.overlaps) {
        lines.push(row([dateStr ?? day.label, dayName ?? '', '', '', 'Overlapping entries', o]));
      }
    }
    lines.push('');
    lines.push(row(['Grand total', '', '', secsToHoursNum(doc.grandTotal)]));
  }

  return '﻿' + lines.join('\r\n');
}
