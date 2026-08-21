// The "report" PDF template: a multi-page, editorially typeset document — cover,
// summary with totals by project and billing code, a chronological day log, and a
// sign-off page. Registered twice (English and Czech) over one builder; all text
// lives in the string tables below. Uses the embedded Fraunces / IBM Plex Mono
// cuts (see reportFonts.ts) next to pdfmake's bundled Roboto.
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
import type { PdfTemplate, SignatureWidget } from './templates';
import { allocate, allocateMd, allocateShares, makeMoney, HOURS_PER_MD } from './money';

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

// ---- the sign-off signatures ----
//
// The report is signed by its ISSUER — the person whose hours it reports — and
// the left-hand "Prepared by" box is where that signature goes. (The right-hand
// box is the client's, and the acceptance protocol's box is the client's too:
// see ./templates.ts.) So this rectangle has to be knowable before the document
// exists, because the signing stage is handed a finished blob that says nothing
// about where a flowing block landed — and on the sign-off page the flow above
// the signatures varies with the investment box and how far the declaration
// wraps.
//
// It is guaranteed rather than reported, by the same two-part trick the widget
// contract calls for:
//
//  - `signatureReserve` flows at the end of the page's content. It is an
//    invisible canvas exactly as tall as the signature row, so pdfmake's own
//    "does this still fit above the bottom margin" arithmetic pushes it — and
//    with it the row — onto a fresh page as soon as the flow reaches the
//    reserved band. A `pageBreakBefore` rule keyed on its id asserts the same
//    thing directly, so the contract does not rest on a measured height alone.
//  - the row itself is drawn at a fixed `absolutePosition`, in three pieces per
//    block, so the dashed box's Y needs no text metrics.
//
// This is also why the "Basis of preparation" box sits ABOVE the signatures
// rather than below them: the signature row is bottom-anchored, so anything
// after it in the flow would have nowhere to go.
const REPORT_PAGE = { width: 595.28, height: 841.89 };
const SIGN = {
  left: 48,
  /** Room above the box for the rule, the role and (up to two lines of) name. */
  headerHeight: 64,
  /** The box: sized for a signature widget's stamp, not for a pen stroke. */
  box: { width: CW / 2 - 20, height: 76 },
  /** Gap between the issuer's block and the client's. */
  gap: 40,
  /**
   * Clearance between the row and the bottom margin. Not cosmetic: pdfmake
   * still applies its does-this-line-fit test to absolutely positioned content,
   * so a date line placed flush against the margin is moved to a page of its
   * own — which also makes that empty page the last one, and the widget follows
   * the last page.
   */
  bottomGap: 12,
};
const SIGN_ROW_HEIGHT = SIGN.headerHeight + SIGN.box.height;
/** Top of the row, measured up from the page's 60pt bottom margin. */
const SIGN_ROW_TOP = REPORT_PAGE.height - 60 - SIGN.bottomGap - SIGN_ROW_HEIGHT;
/** Node id the page-break rule keys on. */
const SIGN_ANCHOR_ID = 'report-signature-anchor';

/** The issuer's box — where a digital signature lands. */
export const REPORT_SIGNATURE_WIDGET: SignatureWidget = {
  rect: {
    x: SIGN.left,
    y: SIGN_ROW_TOP + SIGN.headerHeight,
    width: SIGN.box.width,
    height: SIGN.box.height,
  },
  page: REPORT_PAGE,
};

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
  const projColor = new Map(projectNames.map((p, i) => [p, PROJECT_COLORS[i % PROJECT_COLORS.length]]));
  const dot = (project: string, text: string, style: string): TableCell =>
    projColor.has(project) ? (dotted(projColor.get(project) as string, text, style) as TableCell) : { text, style };

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

  const initials = (personName || '·')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  // A client name is never truncated away — it is who the document is for — so
  // the type shrinks to fit instead.
  const coverTitleSize =
    client.length > 96 ? 15 : client.length > 58 ? 20 : client.length > 32 ? 26 : 33;

  const projectsLabel = (() => {
    const names = projectNames.map((p) => clamp(p, MAX.project));
    if (names.length === 0) return clamp(doc.title, MAX.project);
    if (names.length <= MAX.projectsOnCover) return names.join(' · ');
    const shown = names.slice(0, MAX.projectsOnCover).join(' · ');
    return `${shown} ${L.andMore(names.length - MAX.projectsOnCover)}`;
  })();

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
                { text: personName, style: 'brandName' },
                ...(role ? [{ text: role.toUpperCase(), style: 'brandRole', margin: [0, 2, 0, 0] } as Content] : []),
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
    { text: client, style: 'coverTitle', fontSize: coverTitleSize, margin: [0, 12, 0, 0] },
    { text: range, style: 'coverSub', margin: [0, 8, 0, 0] },
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 64, h: 3, color: R.accent }], margin: [0, 20, 0, 0] },
    {
      // Pinned to the foot of the cover. Sits at 604 (not lower) so a wrapped
      // client, project or reference value still clears the bottom margin.
      absolutePosition: { x: 48, y: 604 },
      table: {
        widths: [CW / 2 - 14, CW / 2 - 14],
        body: [
          [
            { stack: [{ text: L.metaClient.toUpperCase(), style: 'metaK' }, { text: client, style: 'metaVSerif' }] },
            {
              stack: [
                { text: L.metaProjects.toUpperCase(), style: 'metaK' },
                { text: projectsLabel, style: 'metaV' },
              ],
            },
          ],
          [
            { stack: [{ text: L.metaRef.toUpperCase(), style: 'metaK' }, { text: ref, style: 'metaVMono' }] },
            { stack: [{ text: L.metaPreparedBy.toUpperCase(), style: 'metaK' }, { text: personName, style: 'metaV' }] },
          ],
          [
            {
              stack: [
                { text: L.metaEffort.toUpperCase(), style: 'metaK' },
                {
                  text: `${h(totalSecs)} h · ${mdNum(totalMd, L.localeTag)} MD · ${nDays} ${L.daysWord(nDays)}`,
                  style: 'metaVMono',
                },
              ],
            },
            totalFee != null
              ? { stack: [{ text: L.metaFees.toUpperCase(), style: 'metaK' }, { text: money.amount(totalFee), style: 'metaVMono' }] }
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
        paddingTop: () => 10,
        paddingBottom: () => 10,
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
            L.kpiHoursNote(mdNum(totalMd, L.localeTag))
          ),
          kpiCell(L.kpiDays, { text: String(nDays), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiDaysNote(nDays ? hoursNum(totalSecs / nDays, L.localeTag, 1) : '0')),
          kpiCell(L.kpiCodes, { text: String(nCodes), style: 'kpiV', margin: [0, 4, 0, 2] }, L.kpiCodesNote(nProjects)),
          totalFee != null
            ? kpiCell(L.kpiFees, { text: money.amount(totalFee), style: 'kpiVSmall', margin: [0, 7, 0, 3] }, L.kpiFeesNote)
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

  const pctStr = (n: number) => `${n}${locale === 'cs' ? ' %' : '%'}`;

  const projTable: Content = {
    table: {
      headerRows: 1,
      widths: rate != null ? ['*', 42, 40, 38, 80, 86] : ['*', 52, 48, 46],
      body: [
        [
          { text: L.thProject.toUpperCase(), style: 'th' },
          { text: L.thHours.toUpperCase(), style: 'th', alignment: 'right' },
          { text: L.thMd.toUpperCase(), style: 'th', alignment: 'right' },
          { text: L.thShare.toUpperCase(), style: 'th', alignment: 'right' },
          ...(rate != null
            ? [
                { text: L.thRate.toUpperCase(), style: 'th', alignment: 'right' as const },
                { text: L.thFees.toUpperCase(), style: 'th', alignment: 'right' as const },
              ]
            : []),
        ],
        ...projRows.map(([name, secs], i): TableCell[] => [
          dot(name, clamp(name || doc.title, MAX.project), 'td'),
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
          { text: L.thCode.toUpperCase(), style: 'th' },
          { text: L.thProject.toUpperCase(), style: 'th' },
          { text: L.thHours.toUpperCase(), style: 'th', alignment: 'right' },
          { text: L.thMd.toUpperCase(), style: 'th', alignment: 'right' },
          ...(rate != null ? [{ text: L.thFees.toUpperCase(), style: 'th', alignment: 'right' as const }] : []),
        ],
        ...codeRows.map(([, v], i): TableCell[] => [
          { text: clamp(v.code, MAX.code), style: 'tdMono' },
          dot(v.project, clamp(v.project || doc.title, MAX.project), 'td'),
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
        ...(hasTimes ? [{ text: fmtTimeRange(l.startMs, l.endMs, locale), style: 'tdMonoMuted' }] : []),
        { text: clamp(l.code, MAX.code), style: 'tdMono' },
        ...(doc.multi ? [dot(l.project, '', 'td')] : []),
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
                  dot(
                    name,
                    // The breakdown line speaks in the rate's own unit: hours
                    // for an hourly engagement, allocated MD for an MD one.
                    basis === 'md'
                      ? `${clamp(name || doc.title, MAX.project)} · ${mdNum(projMd.rows[i], L.localeTag)} MD × ${money.rate(rate)}/MD`
                      : `${clamp(name || doc.title, MAX.project)} · ${h(secs)} h × ${money.rate(rate)}/h`,
                    'td'
                  ),
                  { text: money.amount(projFees.rows[i]), style: 'tdNum', alignment: 'right' },
                ]),
                [
                  { text: L.feesTotal, style: 'investTotal' },
                  { text: money.amount(totalFee), style: 'investTotalNum', alignment: 'right' },
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
          { text: L.feesNote(basis), style: 'smallMuted', margin: [0, 8, 0, 0] },
        ]
      : [];

  // The signature row: two blocks, each drawn as three absolutely positioned
  // pieces so the dashed box lands at a fixed Y. See SIGN near the top of the
  // file for why the position is fixed rather than flowed.
  const { box: SIG } = SIGN;
  const signBlock = (x: number, signRole: string, name: string): Content[] => [
    {
      absolutePosition: { x, y: SIGN_ROW_TOP },
      // Wrapped in a single fixed-width column so a long name wraps inside the
      // block instead of running under the one beside it.
      columns: [
        {
          width: SIG.width,
          stack: [
            {
              canvas: [
                { type: 'line', x1: 0, y1: 0, x2: SIG.width, y2: 0, lineWidth: 1.2, lineColor: R.ink },
              ],
            },
            { text: signRole, style: 'signRole', margin: [0, 8, 0, 0] },
            { text: name || ' ', style: 'signName', margin: [0, 2, 0, 0] },
            { text: L.signatureHint, style: 'signHint', margin: [0, 10, 0, 0] },
          ],
        },
      ],
    },
    {
      absolutePosition: { x, y: SIGN_ROW_TOP + SIGN.headerHeight },
      canvas: [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: SIG.width,
          h: SIG.height,
          lineWidth: 0.75,
          lineColor: R.faint,
          dash: { length: 2.5, space: 2.5 },
        },
      ],
    },
    {
      // The date prompt goes INSIDE the box rather than on a line beneath it.
      // Beneath it, it would be a blank that nothing ever fills: a digital
      // signature records its date inside the box (the stamp prints it, and the
      // signature dictionary's /M carries it), so the line would sit empty
      // under a signature that is already dated. Inside, it reads as part of
      // what the box asks for — and the stamp, which paints its own background,
      // covers it the moment the box is signed.
      absolutePosition: {
        x: x + 6,
        y: SIGN_ROW_TOP + SIGN.headerHeight + SIG.height - 15,
      },
      text: L.dateLine,
      style: 'signDateHint',
    },
  ];

  // `id` is cast in: pdfmake honours it on every node (it is how the
  // pageBreakBefore rule identifies this one), but @types/pdfmake declares it
  // only on a few content shapes, canvas not among them.
  const signatureReserve = {
    id: SIGN_ANCHOR_ID,
    // A fully transparent fill: it measures the row's full height — which is
    // what makes pdfmake reserve the band — while drawing nothing. It has to be
    // a real op with real extents, because pdfmake drops zero-extent nodes from
    // the list its page-break rule walks, and a dropped anchor would be a
    // silent no-guarantee. `lineWidth` is left off on purpose: 0 means "the
    // thinnest line the device can draw", not "no line".
    canvas: [
      {
        type: 'rect',
        x: 0,
        y: 0,
        w: 1,
        h: SIGN_ROW_HEIGHT + SIGN.bottomGap,
        color: R.paper,
        fillOpacity: 0,
      },
    ],
  } as unknown as Content;

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
      unbreakable: true,
      margin: [0, 30, 0, 0],
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                { text: L.basisTitle.toUpperCase(), style: 'basisTitle' },
                // The engagement sentence is the user's own wording, in this
                // template's language — it leads, because it says what the
                // document is; the standing wording below says how it was made.
                ...(engagement
                  ? [{ text: engagement, style: 'basisLead', margin: [0, 5, 0, 0] } as Content]
                  : []),
                { text: L.basis, style: 'smallMuted', margin: [0, engagement ? 6 : 5, 0, 0] },
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
    signatureReserve,
    ...signBlock(SIGN.left, L.preparedBy, [personName, role].filter(Boolean).join(' · ')),
    ...signBlock(
      SIGN.left + SIGN.box.width + SIGN.gap,
      L.approvedBy,
      clamp(doc.approver, MAX.approver)
    ),
  ];

  return {
    pageOrientation: 'portrait',
    pageSize: 'A4',
    pageMargins: [48, 48, 48, 60],
    info: { title: `${L.docTitle} — ${client}`.trim() },
    content: [...cover, ...summaryPage, ...detailPage, ...signoffPage],
    // The other half of the placement guarantee: never let the flow reach into
    // the band the signature row is drawn in.
    pageBreakBefore: (node) =>
      node.id === SIGN_ANCHOR_ID && node.startPosition.top > SIGN_ROW_TOP,
    footer: (currentPage: number, pageCount: number): Content =>
      currentPage === 1
        ? { text: '' }
        : {
            margin: [48, 14, 48, 0],
            columns: [
              { text: `${personName} · ${L.confidential}`.toUpperCase(), style: 'foot' },
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
      metaVMono: { font: 'IBMPlexMono', fontSize: 9, bold: true, color: R.ink, margin: [0, 3, 0, 0] },
      pheadTitle: { font: 'Fraunces', fontSize: 17, color: R.ink },
      pheadNote: { fontSize: 7, color: R.muted, characterSpacing: 1.4 },
      sectionH: { fontSize: 7.4, bold: true, color: R.accent, characterSpacing: 1.5 },
      lead: { font: 'Fraunces', fontSize: 11, color: R.ink2, lineHeight: 1.35 },
      kpiK: { fontSize: 6.4, color: R.muted, characterSpacing: 1 },
      kpiV: { font: 'IBMPlexMono', fontSize: 16, color: R.ink },
      kpiVSmall: { font: 'IBMPlexMono', fontSize: 10, color: R.ink },
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
      signHint: { fontSize: 6.6, color: R.faint, characterSpacing: 0.6 },
      signDateHint: { fontSize: 7, color: R.faint },
      basisLead: { fontSize: 7.9, color: R.ink2, lineHeight: 1.45 },
      signName: { fontSize: 8.2, color: R.muted },
      basisTitle: { fontSize: 7, bold: true, color: R.muted, characterSpacing: 1.5 },
      smallMuted: { fontSize: 7.6, color: R.muted, lineHeight: 1.4 },
      foot: { fontSize: 6.6, color: R.muted, characterSpacing: 1 },
      footMono: { font: 'IBMPlexMono', fontSize: 7, color: R.muted },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: R.ink },
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
    fontset: 'report',
    signatureWidget: REPORT_SIGNATURE_WIDGET,
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
    fontset: 'report',
    signatureWidget: REPORT_SIGNATURE_WIDGET,
    build: (doc) => buildReport(doc, 'cs'),
  },
];
