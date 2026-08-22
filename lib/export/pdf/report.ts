// The "report" PDF template: a multi-page document in the visual-identity
// design (see ./identity) — cover, summary with totals by project and billing
// code, a chronological day log, and a sign-off page. Registered twice (English
// and Czech) over one builder; all text lives in the string tables below. Set
// entirely in the embedded IBM Plex Sans cuts (see identityFonts.ts).
//
// Money is optional: with a rate in the export options the report carries fee
// columns and an investment box; without one it stays a time-only document. The
// rate is quoted per hour or per man-day (doc.rateBasis), and every fee line
// speaks in the contract's own unit — an MD-rate engagement reads "MD × rate",
// never a back-computed hourly figure. Amounts are allocated (never
// independently rounded) so every printed column adds up to its printed total —
// see money.ts.
//
// Effort is quoted in hours and in man-days (MD), one MD being an eight-hour day.
//
// The document is fixed-locale by construction: dates, clock times, decimal
// separators and currency all follow the template's own locale, not the browser's.

import type { TDocumentDefinitions, Content, ContentTable, TableCell } from 'pdfmake/interfaces';
import type { ExportDoc, RateBasis } from '../model';
import { DAY_MS } from '@/lib/timesheet/constants';
import type { PdfTemplate } from './templates';
import { allocate, allocateMd, allocateShares, makeMoney, HOURS_PER_MD } from './money';
import {
  VZ,
  F,
  A4_MARGINS,
  CW_PORTRAIT,
  principalRule,
  fullRule,
  hairline,
  signature,
  ruledTableLayout,
  identityBaseStyles,
  identityDefaultStyle,
} from './identity';

type ReportLocale = 'en' | 'cs';

/** Printable width of an A4 portrait page inside the identity margins. */
const CW = CW_PORTRAIT;

// Caps on user-supplied text. A timesheet takes whatever Toggl holds — project
// names, descriptions and client names have no length limit at the source — and
// an unbounded string either overflows a fixed column or, in the day log, grows
// a table row taller than the page it cannot be broken across.
const MAX = {
  client: 160, // cover title; also shrinks (see coverTitleSize)
  person: 90,
  role: 70,
  approver: 90,
  ref: 40,
  engagement: 700, // ~8 printed lines in the basis box
  project: 70,
  code: 44,
  desc: 700, // ~14 printed lines in the day log's description column
  projectsOnCover: 3, // then "+N more"
};

/** Trim to a hard cap, marking the cut so a truncated value never reads as complete. */
function clamp(s: string | null | undefined, max: number): string {
  const t = (s ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

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
  /** Worked example shown in the export dialog, never printed. */
  engagementPlaceholder: string;
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
  thMd: string;
  thShare: string;
  thRate: string;
  thFees: string;
  thCode: string;
  thTime: string;
  thDesc: string;
  total: string;
  periodTotal: string;
  mdNote: string;
  andMore: (n: number) => string;
  detailTitle: string;
  detailFirst: string;
  detailCont: string;
  signoffFees: string;
  signoffPlain: string;
  feesForPeriod: string;
  feesTotal: string;
  /** How fees follow from the records — phrased in the rate's own unit. */
  feesNote: (basis: RateBasis) => string;
  preparedBy: string;
  approvedBy: string;
  signatureHint: string;
  dateLine: string;
  basisTitle: string;
  basis: string;
  page: (n: number, m: number) => string;
  daysWord: (n: number) => string;
  lead: (a: {
    client: string;
    range: string;
    hours: string;
    md: string;
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
    md: string;
    fees: string | null;
    basis: RateBasis;
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
  engagementPlaceholder:
    'Prepared under the [agreement name] of [date] and the order for [scope], end ' +
    'customer [end customer]. The reference above is the invoice number these records ' +
    'support.',
  metaEffort: 'Time recorded',
  metaFees: 'Fees (excl. VAT)',
  metaIssued: 'Issued',
  summary: 'Summary',
  atAGlance: 'Period at a glance',
  kpiHours: 'Hours recorded',
  kpiHoursNote: (md) => `${md} MD`,
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
  thMd: 'MD',
  thShare: 'Share',
  thRate: 'Rate',
  thFees: 'Fees',
  thCode: 'Code',
  thTime: 'Time',
  thDesc: 'Description',
  total: 'Total',
  periodTotal: 'Period total',
  mdNote: `MD = man-day; 1 MD = ${HOURS_PER_MD} h.`,
  andMore: (n) => `+${n} more`,
  detailTitle: 'Detailed time log',
  detailFirst: 'chronological',
  detailCont: 'continued',
  signoffFees: 'Fees & sign-off',
  signoffPlain: 'Confirmation & sign-off',
  feesForPeriod: 'Fees for the period',
  feesTotal: 'Total (excl. VAT)',
  feesNote: (basis) =>
    basis === 'md'
      ? 'All recorded time is chargeable. Fees follow from the recorded man-days at the ' +
        'agreed MD rate and exclude expenses and VAT.'
      : 'All recorded time is chargeable. Fees follow from the recorded hours at the agreed ' +
        'hourly rate and exclude expenses and VAT.',
  preparedBy: 'Prepared by',
  approvedBy: 'Approved by',
  signatureHint: 'Signature or digital signature',
  dateLine: 'Date · ____ / ____ / ________',
  basisTitle: 'Basis of preparation',
  basis:
    'Each line carries a project and billing code from the engagement’s time records, ' +
    'with start and end times where recorded. Hours are rounded to a consistent ' +
    `increment across the period; 1 MD is ${HOURS_PER_MD} hours. Confidential — ` +
    'prepared for the named client only.',
  page: (n, m) => `Page ${n} of ${m}`,
  daysWord: (n) => (n === 1 ? 'day' : 'days'),
  lead: ({ client, range, hours, md, days, codes, projects, fees }) => {
    const codePart = codes === 1 ? 'one billing code' : `${codes} billing codes`;
    const projPart = projects > 1 ? ` on ${projects} projects` : '';
    const feePart = fees ? ` Fees for the period come to ${fees}, excluding VAT.` : '';
    return (
      `This report covers the services delivered to ${client} during ${range}. ` +
      `${hours} hours — ${md} MD — were recorded over ${days} working days, spread across ` +
      `${codePart}${projPart}.${feePart} All recorded time is chargeable to the engagement.`
    );
  },
  declaration: ({ client, ref, range, hours, md, fees, basis }) =>
    `I confirm that the time recorded in this report is a true and accurate record of ` +
    `the services delivered to ${client} under reference ${ref} for the period ${range}. ` +
    `The total submitted for approval is ${hours} hours (${md} MD)` +
    (fees
      ? basis === 'md'
        ? `, with fees of ${fees} at the agreed MD rate, excluding VAT.`
        : `, with fees of ${fees} at the agreed hourly rate, excluding VAT.`
      : `.`),
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
  engagementPlaceholder:
    'Práce byla provedena podle [název smlouvy] ze dne [datum] a navazující objednávky ' +
    'na [předmět objednávky] pro koncového zákazníka [koncový zákazník]. Reference ' +
    'uvedená výše je číslo faktury, k níž je tento výkaz podkladem.',
  metaEffort: 'Vykázaný čas',
  metaFees: 'Cena bez DPH',
  metaIssued: 'Vystaveno',
  summary: 'Souhrn',
  atAGlance: 'Přehled období',
  kpiHours: 'Vykázané hodiny',
  kpiHoursNote: (md) => `${md} MD`,
  kpiDays: 'Pracovní dny',
  kpiDaysNote: (avg) => `průměrně ${avg} h denně`,
  kpiCodes: 'Účtovací kódy',
  kpiCodesNote: (n) => (n > 1 ? `napříč ${n} projekty` : 'jeden projekt'),
  kpiFees: 'Cena',
  kpiFeesNote: 'bez DPH',
  kpiEntries: 'Záznamy',
  kpiEntriesNote: 'časových záznamů',
  byProject: 'Podle projektů',
  byCode: 'Podle účtovacích kódů',
  thProject: 'Projekt',
  thHours: 'Hodiny',
  thMd: 'MD',
  thShare: 'Podíl',
  thRate: 'Sazba',
  thFees: 'Částka',
  thCode: 'Kód',
  thTime: 'Čas',
  thDesc: 'Popis',
  total: 'Celkem',
  periodTotal: 'Celkem za období',
  mdNote: `MD = člověkoden; 1 MD = ${HOURS_PER_MD} h.`,
  // "+2 další", "+5 dalších" — the numeral drives the ending.
  andMore: (n) => `+${n} ${n >= 2 && n <= 4 ? 'další' : 'dalších'}`,
  detailTitle: 'Podrobný rozpis práce',
  detailFirst: 'chronologicky',
  detailCont: 'pokračování',
  signoffFees: 'Fakturace a schválení',
  signoffPlain: 'Potvrzení a schválení',
  feesForPeriod: 'Fakturace za období',
  feesTotal: 'Celkem bez DPH',
  feesNote: (basis) =>
    basis === 'md'
      ? 'Celý vykázaný čas je fakturovatelný. Částky vycházejí z vykázaných člověkodnů a ' +
        'sjednané sazby za MD; nezahrnují DPH ani náklady účtované zvlášť.'
      : 'Celý vykázaný čas je fakturovatelný. Částky vycházejí z vykázaných hodin a sjednané ' +
        'hodinové sazby; nezahrnují DPH ani náklady účtované zvlášť.',
  // Both gendered endings, as a Czech form that either person may sign.
  preparedBy: 'Zpracoval(a)',
  approvedBy: 'Schválil(a)',
  signatureHint: 'Podpis nebo elektronický podpis',
  dateLine: 'Datum · ____ / ____ / ________',
  basisTitle: 'Způsob vykazování',
  basis:
    'Každý řádek je veden na projekt a účtovací kód podle evidence zakázky, u záznamů ' +
    's časem i se začátkem a koncem. Hodiny jsou zaokrouhleny jednotně za celé období, ' +
    `1 MD odpovídá ${HOURS_PER_MD} hodinám. Dokument je důvěrný a je určen výhradně ` +
    'uvedenému klientovi.',
  page: (n, m) => `Strana ${n} z ${m}`,
  // Czech numeral declension: 1 den, 2–4 dny, 5+ dnů.
  daysWord: (n) => (n === 1 ? 'den' : n >= 2 && n <= 4 ? 'dny' : 'dnů'),
  lead: ({ client, range, hours, md, days, codes, projects, fees }) => {
    const dayPart = days === 1 ? 'pracovní den' : days >= 2 && days <= 4 ? 'pracovní dny' : 'pracovních dnů';
    const codePart = codes === 1 ? 'jednom účtovacím kódu' : `${codes} účtovacích kódech`;
    // "ve 2/3/4 projektech", "v 5 projektech" — the preposition follows the numeral.
    const projPart =
      projects > 1 ? ` ${projects >= 2 && projects <= 4 ? 've' : 'v'} ${projects} projektech` : '';
    const feePart = fees ? ` Cena za období činí ${fees} bez DPH.` : '';
    return (
      `Výkaz shrnuje práci odvedenou pro klienta ${client} v období ${range}. ` +
      `Vykázáno je ${hours} h, tedy ${md} MD, za ${days} ${dayPart} na ${codePart}${projPart}.` +
      `${feePart} Celý vykázaný čas je fakturovatelný.`
    );
  },
  declaration: ({ client, ref, range, hours, md, fees, basis }) =>
    `Potvrzuji, že údaje v tomto výkazu odpovídají skutečně odvedené práci pro klienta ` +
    `${client} pod referencí ${ref} za období ${range}. Ke schválení předkládám ` +
    `${hours} h, tedy ${md} MD` +
    (fees
      ? basis === 'md'
        ? `, což při sjednané sazbě za MD odpovídá ceně ${fees} bez DPH.`
        : `, což při sjednané hodinové sazbě odpovídá ceně ${fees} bez DPH.`
      : `.`),
};

// ---- locale formatting ----

const DAYS: Record<ReportLocale, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  cs: ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'],
};
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Czech dates follow the identity's convention (§5.5): zero-padded `04. 08.
// 2026`, a space after each dot, and non-breaking spaces inside the date so it
// never wraps mid-way.
const NBSP = '\u00a0';
const csDate = (d: Date, withYear: boolean): string => {
  const core = `${String(d.getDate()).padStart(2, '0')}.${NBSP}${String(d.getMonth() + 1).padStart(2, '0')}.`;
  return withYear ? `${core}${NBSP}${d.getFullYear()}` : core;
};

function fmtDate(ms: number, locale: ReportLocale, withYear: boolean): string {
  const d = new Date(ms);
  const dayName = DAYS[locale][d.getDay()];
  if (locale === 'cs') return `${dayName} ${csDate(d, withYear)}`;
  const core = `${dayName} ${String(d.getDate()).padStart(2, '0')} ${MONTHS_EN[d.getMonth()]}`;
  return withYear ? `${core} ${d.getFullYear()}` : core;
}

function fmtRange(fromMs: number, toMs: number, locale: ReportLocale): string {
  const a = new Date(fromMs);
  const b = new Date(toMs - DAY_MS); // inclusive last day
  if (locale === 'cs') {
    // Range with a spaced en dash: `01. 08. – 31. 08. 2026`.
    return `${csDate(a, false)} – ${csDate(b, true)}`;
  }
  return `${a.getDate()} ${MONTHS_EN[a.getMonth()]} – ${b.getDate()} ${MONTHS_EN[b.getMonth()]} ${b.getFullYear()}`;
}

/**
 * Clock time in the document's own locale — always 24-hour. Both locales here
 * are 24-hour ones, so a report generated on an en-US machine must not inherit
 * that machine's AM/PM. Czech writes the hour without a leading zero.
 */
function fmtTimeOfDay(ms: number, locale: ReportLocale): string {
  const d = new Date(ms);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${locale === 'cs' ? hh : String(hh).padStart(2, '0')}:${mm}`;
}

function fmtTimeRange(startMs: number | null, endMs: number | null, locale: ReportLocale): string {
  if (startMs == null || endMs == null) return '';
  return `${fmtTimeOfDay(startMs, locale)}–${fmtTimeOfDay(endMs, locale)}`;
}

/** Rounded seconds → localized decimal hours ("126.5" / "126,5"). */
function hoursNum(secs: number, tag: string, maxFrac = 2): string {
  return new Intl.NumberFormat(tag, { maximumFractionDigits: maxFrac }).format(secs / 3600);
}

/** MD value → localized 2-decimal string, matching how MD is allocated. */
function mdNum(md: number, tag: string): string {
  return new Intl.NumberFormat(tag, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(md);
}

// ---- data shaping ----

interface Line {
  dateMs: number;
  startMs: number | null;
  endMs: number | null;
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
          startMs: r.startMs,
          endMs: r.endMs,
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
            startMs: null,
            endMs: null,
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

/** Section label: sentence case, SemiBold — typography, not decoration. */
function sectionH(text: string): Content {
  return { text, style: 'sectionH', margin: [0, 16, 0, 6] };
}

/** Page heading: 16 pt SemiBold title, small Secondary note right, full rule under. */
function phead(title: string, note: string): Content[] {
  return [
    {
      columns: [
        { text: title, style: 'pheadTitle' },
        { text: note, style: 'pheadNote', alignment: 'right', margin: [0, 9, 0, 0] },
      ],
    },
    fullRule(CW, [0, 4, 0, 14]),
  ];
}

// The identity table layout: full rules around the head and the closing total
// row, hairline rows between, Surface head fill, no vertical lines.
const rowTableLayout = ruledTableLayout({ totalRow: true });

// ---- the builder ----

function buildReport(doc: ExportDoc, locale: ReportLocale): TDocumentDefinitions {
  const L = locale === 'cs' ? CS : EN;
  const generatedAt = Date.now();
  const lines = collectLines(doc);
  const hasTimes = doc.view === 'individual' && lines.some((l) => l.startMs != null);
  const rate = doc.rate;
  const basis: RateBasis = doc.rateBasis === 'md' ? 'md' : 'hourly';
  // The printed unit suffix ("450/h" / "9 000/MD") — the same in both locales,
  // since "h" and "MD" already are.
  const rateUnit = basis === 'md' ? '/MD' : '/h';
  const money = makeMoney(L.localeTag, doc.currency || 'CZK');
  // An hourly engagement prices the recorded time. An MD engagement prices the
  // *printed* two-decimal MD quantities instead: the client reads "2,34 MD ×
  // 9 000/MD" next to an amount, and that multiplication must reproduce the
  // amount — pricing the unrounded seconds would put 2.34375 MD of money next
  // to a printed 2,34.
  const hourlyFee = (secs: number) => (secs / 3600) * (rate ?? 0);
  const mdFee = (md: number) => md * (rate ?? 0);

  const personName = clamp(doc.personName, MAX.person);
  const role = clamp(doc.role, MAX.role);
  const client = clamp(doc.client || doc.title, MAX.client);
  const engagement = clamp(doc.engagement, MAX.engagement);
  const totalSecs = doc.grandTotal;
  const range = fmtRange(doc.fromMs, doc.toMs, locale);
  const from = new Date(doc.fromMs);
  // The reference is user-supplied; the year-month default only fills the gap.
  const ref = clamp(
    doc.reference || `TS-${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`,
    MAX.ref
  );
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

  // Every printed column is allocated against its total rather than rounded row
  // by row, so the columns add up exactly as printed.
  const projRows = [...byProject.entries()];
  const projMd = allocateMd(projRows.map(([, s]) => s));
  const projShare = allocateShares(projRows.map(([, s]) => s), totalSecs);
  const projFees =
    rate != null
      ? allocate(
          basis === 'md' ? projMd.rows.map(mdFee) : projRows.map(([, s]) => hourlyFee(s)),
          money.dp
        )
      : null;

  const codeRows = [...byCode.entries()].sort((a, b) => b[1].secs - a[1].secs);
  const codeMd = allocateMd(codeRows.map(([, v]) => v.secs));
  const codeFees =
    rate != null
      ? allocate(
          basis === 'md' ? codeMd.rows.map(mdFee) : codeRows.map(([, v]) => hourlyFee(v.secs)),
          money.dp
        )
      : null;

  const totalMd = allocateMd([totalSecs]).total;
  const totalFee = projFees ? projFees.total : null;

  // -- cover --

  // A client name is never truncated away — it is who the document is for — so
  // the type shrinks to fit instead (22 pt is the cover-title size of the spec).
  const coverTitleSize =
    client.length > 96 ? 13 : client.length > 58 ? 16 : client.length > 32 ? 19 : 22;

  const projectsLabel = (() => {
    const names = projectNames.map((p) => clamp(p, MAX.project));
    if (names.length === 0) return clamp(doc.title, MAX.project);
    if (names.length <= MAX.projectsOnCover) return names.join(' · ');
    const shown = names.slice(0, MAX.projectsOnCover).join(' · ');
    return `${shown} ${L.andMore(names.length - MAX.projectsOnCover)}`;
  })();

  const metaPair = (label: string, value: Content): Content => ({
    stack: [{ text: label, style: 'metaK' }, value],
  });

  const cover: Content[] = [
    {
      columns: [
        { text: L.docType, style: 'coverDocType' },
        // Confidentiality marker, top right (report grammar of the spec, §20).
        { text: L.confidential, style: 'coverDocType', alignment: 'right' },
      ],
    },
    // The cover's principal double rule — the page's one oxide termination
    // (80 mm), opening the upper third.
    principalRule(227, true, [0, 148, 0, 0]),
    { text: client, style: 'coverTitle', fontSize: coverTitleSize, margin: [0, 18, 0, 0] },
    { text: `${L.docTitle} · ${range}`, style: 'coverSub', margin: [0, 8, 0, 0] },
    {
      // Pinned to the foot of the cover. Sits at 596 (not lower) so a wrapped
      // client, project or reference value still clears the bottom margin.
      absolutePosition: { x: 62, y: 596 },
      stack: [
        {
          table: {
            widths: [CW / 2 - 14, CW / 2 - 14],
            body: [
              [
                metaPair(L.metaClient, { text: client, style: 'metaV' }),
                metaPair(L.metaProjects, { text: projectsLabel, style: 'metaV' }),
              ],
              [
                metaPair(L.metaRef, { text: ref, style: 'metaV' }),
                metaPair(L.metaPreparedBy, { text: personName, style: 'metaV' }),
              ],
              [
                metaPair(L.metaEffort, {
                  text: `${h(totalSecs)} h · ${mdNum(totalMd, L.localeTag)} MD · ${nDays} ${L.daysWord(nDays)}`,
                  style: 'metaV',
                }),
                totalFee != null
                  ? metaPair(L.metaFees, { text: money.amount(totalFee), style: 'metaV' })
                  : metaPair(L.metaIssued, {
                      text: fmtDate(generatedAt, locale, true),
                      style: 'metaV',
                    }),
              ],
            ],
          },
          // Hairline-separated metadata rows — no box, no fills.
          layout: {
            hLineWidth: (i: number) => (i === 1 || i === 2 ? 0.3 : 0),
            hLineColor: () => VZ.rule,
            vLineWidth: () => 0,
            paddingTop: () => 8,
            paddingBottom: () => 8,
            paddingLeft: (i: number) => (i === 1 ? 14 : 0),
            paddingRight: (i: number) => (i === 0 ? 14 : 0),
          },
        },
        // The signature — the one place on the cover where the name signs.
        signature(personName, { style: 'coverSign', margin: [0, 22, 0, 0] }),
        ...(role ? [{ text: role, style: 'coverSignRole', margin: [0, 2, 0, 0] } as Content] : []),
      ],
    },
    { text: '', pageBreak: 'after' },
  ];

  // -- summary page --

  // The key figures as a Surface summary band between two full rules — a
  // functional band of the identity, not a card row. Values stay Ink; the
  // document's one oxide value lives on the sign-off page.
  const kpiCell = (k: string, v: Content, d: string): TableCell => ({
    stack: [{ text: k, style: 'kpiK' }, v, { text: d, style: 'kpiD' }],
  });
  const kpis: Content = {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [
        [
          kpiCell(
            L.kpiHours,
            { text: [{ text: h(totalSecs), style: 'kpiV' }, { text: ' h', style: 'kpiVUnit' }], margin: [0, 4, 0, 2] },
            L.kpiHoursNote(mdNum(totalMd, L.localeTag))
          ),
          kpiCell(L.kpiDays, { text: String(nDays), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiDaysNote(nDays ? hoursNum(totalSecs / nDays, L.localeTag, 1) : '0')),
          kpiCell(L.kpiCodes, { text: String(nCodes), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiCodesNote(nProjects)),
          totalFee != null
            ? kpiCell(L.kpiFees, { text: money.amount(totalFee), style: 'kpiVSmall', margin: [0, 8, 0, 3] }, L.kpiFeesNote)
            : kpiCell(L.kpiEntries, { text: String(lines.length), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiEntriesNote),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      hLineColor: () => VZ.ink,
      vLineWidth: () => 0,
      fillColor: () => VZ.surface,
      paddingTop: () => 9,
      paddingBottom: () => 9,
      paddingLeft: () => 10,
      paddingRight: () => 10,
    },
  };

  const pctStr = (n: number) => `${n}${locale === 'cs' ? ' %' : '%'}`;

  const projTable: Content = {
    table: {
      headerRows: 1,
      widths: rate != null ? ['*', 42, 40, 38, 80, 86] : ['*', 52, 48, 46],
      body: [
        [
          { text: L.thProject, style: 'th' },
          { text: L.thHours, style: 'th', alignment: 'right' },
          { text: L.thMd, style: 'th', alignment: 'right' },
          { text: L.thShare, style: 'th', alignment: 'right' },
          ...(rate != null
            ? [
                { text: L.thRate, style: 'th', alignment: 'right' as const },
                { text: L.thFees, style: 'th', alignment: 'right' as const },
              ]
            : []),
        ],
        ...projRows.map(([name, secs], i): TableCell[] => [
          { text: clamp(name || doc.title, MAX.project), style: 'td' },
          { text: h(secs), style: 'tdNum', alignment: 'right' },
          { text: mdNum(projMd.rows[i], L.localeTag), style: 'tdNum', alignment: 'right' },
          { text: pctStr(projShare[i]), style: 'tdMuted', alignment: 'right' },
          ...(rate != null && projFees
            ? [
                { text: `${money.rate(rate)}${rateUnit}`, style: 'tdMuted', alignment: 'right' as const },
                { text: money.amount(projFees.rows[i]), style: 'tdNum', alignment: 'right' as const },
              ]
            : []),
        ]),
        [
          { text: L.total, style: 'totalTd' },
          { text: h(totalSecs), style: 'totalTdNum', alignment: 'right' },
          { text: mdNum(projMd.total, L.localeTag), style: 'totalTdNum', alignment: 'right' },
          { text: pctStr(projShare.reduce((a, b) => a + b, 0)), style: 'totalTdNum', alignment: 'right' },
          ...(rate != null && totalFee != null
            ? [
                { text: '', style: 'totalTd' },
                { text: money.amount(totalFee), style: 'totalTdNum', alignment: 'right' as const },
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
      widths: rate != null ? [88, '*', 42, 40, 86] : [88, '*', 52, 48],
      body: [
        [
          { text: L.thCode, style: 'th' },
          { text: L.thProject, style: 'th' },
          { text: L.thHours, style: 'th', alignment: 'right' },
          { text: L.thMd, style: 'th', alignment: 'right' },
          ...(rate != null ? [{ text: L.thFees, style: 'th', alignment: 'right' as const }] : []),
        ],
        ...codeRows.map(([, v], i): TableCell[] => [
          { text: clamp(v.code, MAX.code), style: 'td' },
          { text: clamp(v.project || doc.title, MAX.project), style: 'td' },
          { text: h(v.secs), style: 'tdNum', alignment: 'right' },
          { text: mdNum(codeMd.rows[i], L.localeTag), style: 'tdNum', alignment: 'right' },
          ...(rate != null && codeFees
            ? [{ text: money.amount(codeFees.rows[i]), style: 'tdNum', alignment: 'right' as const }]
            : []),
        ]),
        [
          { text: L.total, style: 'totalTd', colSpan: 2 },
          {},
          { text: h(totalSecs), style: 'totalTdNum', alignment: 'right' },
          { text: mdNum(codeMd.total, L.localeTag), style: 'totalTdNum', alignment: 'right' },
          ...(rate != null && totalFee != null
            ? [{ text: money.amount(totalFee), style: 'totalTdNum', alignment: 'right' as const }]
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
        md: mdNum(totalMd, L.localeTag),
        days: nDays,
        codes: nCodes,
        projects: nProjects,
        fees: totalFee != null ? money.amount(totalFee) : null,
      }),
      style: 'lead',
    },
    sectionH(L.atAGlance),
    kpis,
    ...(projectNames.length > 0 ? [sectionH(L.byProject), projTable] : []),
    sectionH(L.byCode),
    codeTable,
    { text: L.mdNote, style: 'smallMuted', margin: [0, 8, 0, 0] },
    { text: '', pageBreak: 'after' },
  ];

  // -- detail log --

  // No fee column here on purpose: allocating per line would make identical
  // lines show amounts a minor unit apart. Fees live in the summary tables and
  // the sign-off box, where the per-project allocation stays consistent.
  const detailCols = 2 + (hasTimes ? 1 : 0) + (doc.multi ? 1 : 0) + 1;
  const detailWidths: (string | number)[] = [
    ...(hasTimes ? [56] : []),
    64,
    // A multi-project export names the project on each line (colour coding of
    // rows is not part of the identity).
    ...(doc.multi ? [64] : []),
    '*',
    44,
  ];
  const detailHead: TableCell[] = [
    ...(hasTimes ? [{ text: L.thTime, style: 'th' }] : []),
    { text: L.thCode, style: 'th' },
    ...(doc.multi ? [{ text: L.thProject, style: 'th' }] : []),
    { text: L.thDesc, style: 'th' },
    { text: L.thHours, style: 'th', alignment: 'right' as const },
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
        ...(hasTimes ? [{ text: fmtTimeRange(l.startMs, l.endMs, locale), style: 'tdMuted' }] : []),
        { text: clamp(l.code, MAX.code), style: 'td' },
        ...(doc.multi ? [{ text: clamp(l.project, MAX.project), style: 'tdMuted' }] : []),
        { text: clamp(l.desc, MAX.desc), style: 'td' },
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
        // Day header rows read as Surface summary bands; the table head itself
        // stays unfilled here so the bands carry the day rhythm alone.
        fillColor: (rowIndex: number) => (dayFillRows.has(rowIndex) ? VZ.surface : null),
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
              widths: [270, 100],
              body: [
                ...projRows.map(([name, secs], i): TableCell[] => [
                  {
                    // The breakdown line speaks in the rate's own unit: hours
                    // for an hourly engagement, allocated MD for an MD one.
                    text:
                      basis === 'md'
                        ? `${clamp(name || doc.title, MAX.project)} · ${mdNum(projMd.rows[i], L.localeTag)} MD × ${money.rate(rate)}/MD`
                        : `${clamp(name || doc.title, MAX.project)} · ${h(secs)} h × ${money.rate(rate)}/h`,
                    style: 'td',
                  },
                  { text: money.amount(projFees.rows[i]), style: 'tdNum', alignment: 'right' },
                ]),
                [
                  { text: L.feesTotal, style: 'investTotal' },
                  // The document's one oxide value, over the classic double
                  // underline — the identity's total treatment.
                  { text: money.amount(totalFee), style: 'investTotalNum', alignment: 'right' },
                ],
              ],
            },
            layout: {
              hLineWidth: (i: number, node: ContentTable) =>
                i === 0 || i === node.table.body.length || i === node.table.body.length - 1
                  ? 0.5
                  : 0.3,
              hLineColor: (i: number, node: ContentTable) =>
                i === 0 || i === node.table.body.length || i === node.table.body.length - 1
                  ? VZ.ink
                  : VZ.rule,
              vLineWidth: () => 0,
              paddingTop: () => 5,
              paddingBottom: () => 5,
              paddingLeft: () => 0,
              paddingRight: () => 0,
            },
          },
          { text: L.feesNote(basis), style: 'smallMuted', margin: [0, 8, 0, 0] },
        ]
      : [];

  // Reserved area for the signature. Sized for a digital-signature widget's
  // visual stamp (Adobe / eIDAS panels are around 190x70pt) rather than for a
  // pen stroke on a line, since these reports are signed in a PDF reader.
  const SIG_W = CW / 2 - 20;
  const SIG_H = 76;

  const signBlock = (signRole: string, name: string): Content => ({
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0.25, x2: SIG_W, y2: 0.25, lineWidth: 0.5, lineColor: VZ.ink }] },
      { text: signRole, style: 'signRole', margin: [0, 8, 0, 0] },
      { text: name || ' ', style: 'signName', margin: [0, 2, 0, 0] },
      { text: L.signatureHint, style: 'signHint', margin: [0, 10, 0, 0] },
      {
        canvas: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: SIG_W,
            h: SIG_H,
            lineWidth: 0.5,
            lineColor: VZ.secondary,
            dash: { length: 2.5, space: 2.5 },
          },
        ],
        margin: [0, 4, 0, 0],
      },
      { text: L.dateLine, style: 'smallMuted', margin: [0, 8, 0, 0] },
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
        md: mdNum(totalMd, L.localeTag),
        fees: totalFee != null ? money.amount(totalFee) : null,
        basis,
      }),
      style: 'declare',
      margin: [0, rate != null ? 22 : 4, 0, 0],
    },
    {
      columns: [
        signBlock(L.preparedBy, [personName, role].filter(Boolean).join(' · ')),
        signBlock(L.approvedBy, clamp(doc.approver, MAX.approver)),
      ],
      columnGap: 40,
      margin: [0, 36, 0, 0],
    },
    {
      // Basis of preparation as a footnote block — a hairline above, never a
      // box around content (the identity's rule grammar).
      unbreakable: true,
      margin: [0, 30, 0, 0],
      stack: [
        hairline(CW, [0, 0, 0, 8]),
        { text: L.basisTitle, style: 'basisTitle' },
        // The engagement sentence is the user's own wording, in this
        // template's language — it leads, because it says what the
        // document is; the standing wording below says how it was made.
        ...(engagement
          ? [{ text: engagement, style: 'basisLead', margin: [0, 5, 0, 0] } as Content]
          : []),
        { text: L.basis, style: 'smallMuted', margin: [0, engagement ? 6 : 5, 0, 0] },
      ],
    },
  ];

  return {
    pageOrientation: 'portrait',
    pageSize: 'A4',
    pageMargins: A4_MARGINS,
    info: { title: `${L.docTitle} — ${client}`.trim() },
    content: [...cover, ...summaryPage, ...detailPage, ...signoffPage],
    footer: (currentPage: number, pageCount: number): Content =>
      currentPage === 1
        ? { text: '' }
        : {
            // Footer on the bottom margin line, above a hairline (§8).
            margin: [62, 10, 62, 0],
            stack: [
              hairline(CW, [0, 0, 0, 4]),
              {
                columns: [
                  { text: `${personName} · ${L.confidential}`, style: 'foot' },
                  { text: ref, style: 'foot', alignment: 'center' },
                  { text: L.page(currentPage, pageCount), style: 'foot', alignment: 'right' },
                ],
              },
            ],
          },
    styles: {
      ...identityBaseStyles,
      coverDocType: { font: F.medium, fontSize: 7.5, color: VZ.secondary },
      coverTitle: { fontSize: 22, bold: true, color: VZ.ink, lineHeight: 1.1 },
      coverSub: { fontSize: 11, color: VZ.secondary },
      coverSign: { fontSize: 12, bold: true, color: VZ.ink },
      coverSignRole: { fontSize: 7.5, color: VZ.secondary },
      metaK: { font: F.medium, fontSize: 7, color: VZ.secondary },
      metaV: { fontSize: 8.5, bold: true, color: VZ.ink, margin: [0, 3, 0, 0] },
      pheadTitle: { fontSize: 16, bold: true, color: VZ.ink },
      pheadNote: { fontSize: 7.5, color: VZ.secondary },
      sectionH: { fontSize: 10, bold: true, color: VZ.ink },
      lead: { fontSize: 9.5, color: VZ.ink, lineHeight: 1.5 },
      kpiK: { font: F.medium, fontSize: 7, color: VZ.secondary },
      kpiV: { fontSize: 15, bold: true, color: VZ.ink },
      kpiVSmall: { fontSize: 10.5, bold: true, color: VZ.ink },
      kpiVUnit: { fontSize: 9, color: VZ.secondary },
      kpiD: { fontSize: 7, color: VZ.secondary },
      th: { font: F.medium, fontSize: 7, bold: true, color: VZ.secondary },
      td: { fontSize: 8.5, color: VZ.ink },
      tdMuted: { fontSize: 8.5, color: VZ.secondary },
      tdNum: { fontSize: 8.5, color: VZ.ink },
      dayHdr: { fontSize: 7.5, bold: true, color: VZ.ink },
      dayHdrNum: { fontSize: 8, bold: true, color: VZ.ink },
      totalTd: { fontSize: 8.8, bold: true, color: VZ.ink },
      totalTdNum: { fontSize: 8.8, bold: true, color: VZ.ink },
      investTotal: { fontSize: 9, bold: true, color: VZ.ink },
      // The document's one oxide value, over the classic double underline.
      investTotalNum: {
        fontSize: 9.5,
        bold: true,
        color: VZ.oxide,
        decoration: 'underline',
        decorationStyle: 'double',
        decorationColor: VZ.ink,
      },
      declare: { fontSize: 9.5, color: VZ.ink, lineHeight: 1.5 },
      signRole: { fontSize: 9, bold: true, color: VZ.ink },
      signHint: { fontSize: 6.5, color: VZ.secondary },
      basisLead: { fontSize: 8, color: VZ.ink, lineHeight: 1.45 },
      signName: { fontSize: 8, color: VZ.secondary },
      basisTitle: { font: F.medium, fontSize: 7, bold: true, color: VZ.secondary },
      smallMuted: { fontSize: 7.5, color: VZ.secondary, lineHeight: 1.4 },
      foot: { fontSize: 6.5, color: VZ.secondary },
    },
    defaultStyle: identityDefaultStyle,
  };
}

/** Worked examples for the engagement note, by template language (UI only). */
export const ENGAGEMENT_PLACEHOLDERS: Record<'en' | 'cs', string> = {
  en: EN.engagementPlaceholder,
  cs: CS.engagementPlaceholder,
};

/** Localized label + helper text for the engagement note (UI only). */
export const ENGAGEMENT_LABELS: Record<'en' | 'cs', string> = {
  en: 'English',
  cs: 'Czech',
};

// Registered as two entries so the language reads directly in the template picker.
export const reportTemplates: PdfTemplate[] = [
  {
    id: 'report-en',
    name: 'Timesheet Report (EN)',
    description:
      'A multi-page report in English: cover, summary with totals by project and billing ' +
      'code (hours and MD), a day-by-day log, and a sign-off page. Add an hourly or MD ' +
      'rate to include fees.',
    fields: ['role', 'client', 'approver', 'reference', 'engagement', 'rate'],
    locale: 'en',
    fontset: 'identity',
    build: (doc) => buildReport(doc, 'en'),
  },
  {
    id: 'report-cs',
    name: 'Výkaz práce (CZ)',
    description:
      'Vícestránkový výkaz v češtině: titulní strana, souhrn podle projektů a účtovacích ' +
      'kódů (hodiny i MD), denní rozpis a strana pro schválení. Po zadání hodinové sazby ' +
      'nebo sazby za MD doplní i cenu.',
    fields: ['role', 'client', 'approver', 'reference', 'engagement', 'rate'],
    locale: 'cs',
    fontset: 'identity',
    build: (doc) => buildReport(doc, 'cs'),
  },
];
