// Compact day aggregation for the Timesheet Acceptance Protocol template.
//
// The Full variant concatenates every exported row of a day ("CODE - desc; …"),
// which the approver has to read line by line. The Compact variant renders the
// same day as ONE line: every billing code of the day (descending hours), then
// a single overall description — no per-entry or per-group times, the day's
// Hours/MD columns already carry the total. The aggregation is purely
// presentational: it works on the rows the export already produced (rounded
// seconds and all), so the day's Hours/MD figures are untouched by design.

/** One exported row of a day, as either view produces it. */
export interface CompactRow {
  /**
   * Billing code as exported (may carry a trailing parenthetical name and — in
   * a multi-project export — a "Project: " prefix). This is what prints.
   */
  code: string;
  /**
   * The unprefixed billing code, for classification: a "Project: " prefix must
   * not stop a ticket-shaped code from classifying as a support ticket.
   * Falls back to `code` when absent.
   */
  billingCode?: string;
  /** The row's merged description ("; "-joined de-duplicated parts). */
  desc: string;
  /** Rounded seconds billed to this row on this day. */
  seconds: number;
}

// ---- text hygiene ----

// Typos that keep arriving through the copy/PDF pipeline the entries come from.
// Case of the first letter is preserved ("Defnice" → "Definice"). "poklady" is
// bounded so the correct "podklady" (which does not contain it) is never touched.
const TYPO_FIXES: Array<[RegExp, string]> = [
  [/fnalizace/gi, 'finalizace'],
  [/defnice/gi, 'definice'],
  [/\bpoklady\b/gi, 'podklady'],
];

/** Fix known mojibake/typos in an entry description (both template variants). */
export function fixDescTypos(text: string): string {
  let out = text;
  for (const [re, to] of TYPO_FIXES) {
    out = out.replace(re, (m) =>
      m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to
    );
  }
  return out;
}

// ---- classification ----

// A ticket-shaped billing code — one alphabetic token, a hyphen, a number
// ("TCK-104020"). Cannot match structured project codes ("X-CLD-900",
// "X-MDS-1") or letters-only ones ("X-CRM"). These codes come from the
// support-ticket fallback (an untagged entry titled "[TCK-…] …"); their
// descriptions are boilerplate the day description ignores.
const TICKET_CODE_RE = /^[A-Za-z]+-\d+$/;

/** A support-tagged row (".X-Support" exported directly, without the fallback). */
const SUPPORT_TAG_RE = /support/i;

// A tag named after meetings (e.g. "X-CLD-249 (Cloud - schůzky)"): its
// descriptions never feed the day description — individual meeting names carry
// no information the approver needs. Keyed off the tag NAME, not a "Meeting | "
// description prefix: ad-hoc meetings (stand-ups, 1:1s) are often logged
// without the prefix, and the tag is what actually declares "this is meetings".
const MEETINGS_TAG_RE = /sch[uů]zk/i;

/** Ticket ids mentioned inside a description ("TCK-104020"). */
const TICKET_IN_TEXT_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

// "… (+ řešení 7 obdobných tiketů)" — the description says more tickets hide
// behind this one, so the code list gets an "a další" after that ticket.
const MORE_TICKETS_RE = /\+\s*řešení|obdobných\s+ti[ck]et/i;

/** Sub-descriptions the timesheet merge produced, minus join artifacts. */
const splitParts = (desc: string): string[] =>
  desc
    .split('; ')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '…');

const MEETING_PREFIX_RE = /^meeting\s*\|\s*/i;

/** Display form of a billing code: the trailing parenthetical name dropped. */
const displayTag = (code: string): string => code.replace(/\s*\([^()]*\)\s*$/, '').trim();

// ---- near-duplicate descriptions ----

// The timesheet merge dedupes only EXACT descriptions, so a pair like
// "…finální architektura" / "…finální architektur, předávka na jiného
// architekta" survives as two parts and would render as "A + B". When every
// word of the shorter description leads the longer one, the longer is the same
// work with a tail appended — they merge into the shorter text, pooling their
// hours (and the pooled part then competes for dominance as one).

/** Comparison words: whitespace-split, lowercased, trailing punctuation dropped. */
const compareWords = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((w) => w.replace(/[.,;:]+$/, '').toLowerCase())
    .filter((w) => w !== '');

/**
 * True when `short` is the beginning of `long`, word for word. Only the
 * shorter's LAST word may differ, and then only as a truncation of its
 * counterpart ("architektur" / "architektura") — a differing full word there
 * ("příprava" / "zápis") is a different activity and must not merge.
 */
function tailVariant(short: string[], long: string[]): boolean {
  if (short.length < 2 || short.length > long.length) return false;
  for (let i = 0; i < short.length - 1; i++) {
    if (short[i] !== long[i]) return false;
  }
  const a = short[short.length - 1];
  const b = long[short.length - 1];
  return a === b || a.startsWith(b) || b.startsWith(a);
}

interface Part {
  text: string;
  weight: number;
  order: number;
}

/** Fold tail-variant parts together, each cluster keeping its shortest text. */
function mergeTailVariants(parts: Part[]): Part[] {
  const clusters: Array<Part & { words: string[] }> = [];
  for (const p of parts) {
    const w = compareWords(p.text);
    const hit = clusters.find(
      (c) => (w.length <= c.words.length ? tailVariant(w, c.words) : tailVariant(c.words, w))
    );
    if (!hit) {
      clusters.push({ ...p, words: w });
      continue;
    }
    hit.weight += p.weight;
    hit.order = Math.min(hit.order, p.order);
    if (w.length < hit.words.length) {
      hit.text = p.text;
      hit.words = w;
    }
  }
  return clusters.map(({ text, weight, order }) => ({ text, weight, order }));
}

// ---- the day description ----

// A description carrying at least this share of the day's described project
// hours stands alone as the day description; below it the top two carry it.
const DOMINANCE_SHARE = 0.65;

// "max ~50 characters": a description a hair over stays whole (cutting it
// would drop a word for nothing); a genuinely long one is cut at a word
// boundary and marked.
const SUMMARY_MAX = 50;
const SUMMARY_TOLERANCE = 8;

function shorten(text: string): string {
  if (text.length <= SUMMARY_MAX + SUMMARY_TOLERANCE) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const at = cut.lastIndexOf(' ');
  return (at > SUMMARY_MAX / 2 ? cut.slice(0, at) : cut).trimEnd() + '…';
}

interface CodeEntry {
  label: string;
  seconds: number;
  order: number; // first-seen order, the tiebreak for equal hours
  /** Support ticket whose description declares more tickets behind it. */
  more: boolean;
}

/**
 * The Compact variant's Project / Task cell for one day: every billing code of
 * the day (display form, descending hours), " – ", one overall description.
 *
 * The description is the day's main PROJECT work: descriptions of meetings-tag
 * and support-ticket rows never feed it (meeting names and ticket boilerplate
 * carry nothing the approver needs — the ticket ids are already in the code
 * list). A ≥65% dominant description stands alone; below that the top two join
 * with " + ". A day of only meetings and/or tickets still says so ("schůzky",
 * "řešení tiketů") — something is always there when the day had work.
 */
export function compactDayText(rows: CompactRow[]): string {
  const codes = new Map<string, CodeEntry>();
  const codeFor = (label: string): CodeEntry => {
    const key = label.toLowerCase();
    let e = codes.get(key);
    if (!e) {
      e = { label, seconds: 0, order: codes.size, more: false };
      codes.set(key, e);
    }
    return e;
  };

  // Weighted distinct project descriptions, keyed case-insensitively.
  const parts = new Map<string, Part>();
  let describedSecs = 0; // the dominance denominator
  let meetings = false;
  let support = false;

  for (const row of rows) {
    const code = row.code.trim();
    const tag = displayTag(code); // printed label, project prefix and all
    const bare = displayTag((row.billingCode ?? row.code).trim()); // classification

    if (TICKET_CODE_RE.test(bare) || SUPPORT_TAG_RE.test(code)) {
      support = true;
      // The ticket ids ARE the billing codes: the row's own printed code when
      // it is one, otherwise whatever the description names (a directly-tagged
      // support row) — falling back to the tag itself when it names none.
      const ids = TICKET_CODE_RE.test(bare)
        ? [tag]
        : row.desc.match(TICKET_IN_TEXT_RE) ?? (tag ? [tag] : []);
      for (const id of ids) {
        const e = codeFor(id);
        e.seconds += row.seconds;
        if (MORE_TICKETS_RE.test(row.desc)) e.more = true;
      }
      continue;
    }

    if (tag) {
      const e = codeFor(tag);
      e.seconds += row.seconds;
      if (MEETINGS_TAG_RE.test(code)) {
        meetings = true;
        continue;
      }
    }

    // Distinct descriptions, "Meeting | " stripped and typos fixed, each
    // carrying an even share of the row's hours (the export model holds no
    // finer split within a merged row). Untagged rows land here too — they
    // have no code to list, but their work still describes the day.
    describedSecs += row.seconds;
    const rowParts = splitParts(row.desc);
    const weight = rowParts.length > 0 ? row.seconds / rowParts.length : 0;
    for (const raw of rowParts) {
      const text = fixDescTypos(raw.replace(MEETING_PREFIX_RE, ''));
      const key = text.toLowerCase();
      const p = parts.get(key) ?? { text, weight: 0, order: parts.size };
      p.weight += weight;
      parts.set(key, p);
    }
  }

  const codeList = [...codes.values()]
    .sort((a, b) => b.seconds - a.seconds || a.order - b.order)
    .map((e) => (e.more ? `${e.label} a další` : e.label))
    .join(', ');

  const ranked = mergeTailVariants([...parts.values()]).sort(
    (a, b) => b.weight - a.weight || a.order - b.order
  );
  let desc = '';
  if (ranked.length > 0) {
    // One description dominating the day's project work stands alone;
    // otherwise the top two carry it. (A single part is trivially dominant.)
    desc =
      ranked.length === 1 || ranked[0].weight >= DOMINANCE_SHARE * describedSecs
        ? shorten(ranked[0].text)
        : `${shorten(ranked[0].text)} + ${shorten(ranked[1].text)}`;
  } else if (meetings && support) {
    desc = 'schůzky a řešení tiketů';
  } else if (meetings) {
    desc = 'schůzky';
  } else if (support) {
    desc = 'řešení tiketů';
  }

  if (codeList && desc) return `${codeList} – ${desc}`;
  return codeList || desc;
}
