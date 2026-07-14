// The description-length rule: some clients' timesheet systems reject entry
// messages over N characters, so an optional per-workspace limit caps every
// merged description the timesheet produces. Enforced here, in one place, so the
// on-screen views, the copy buttons and every export emit the identical fitted
// text — what you copy is guaranteed to paste.

/** A merged description after the optional length limit has been applied. */
export interface FittedDesc {
  /** The text to display / copy / export. Never longer than the limit. */
  text: string;
  /** True when anything had to be dropped or cut to fit. */
  truncated: boolean;
  /** The unlimited join, for the on-screen "what was dropped" tooltip. */
  full: string;
}

/** The marker appended when whole description parts were dropped. */
const DROPPED = '; …';

/**
 * Join merged description parts ("; "-separated, as everywhere in the app) and
 * fit the result within `maxLen` characters (null/0 = no limit — today's
 * behavior, byte-for-byte).
 *
 * When over the limit, whole parts are kept in first-seen order while they fit
 * and the rest is dropped behind a trailing "; …" — descriptions stay readable
 * sentences rather than mid-word cuts, and the earliest (most load-bearing)
 * parts win: a linked-code cell's per-code breakdown is its first part, so it
 * survives while the merged entry chatter goes. Only when even the FIRST part
 * alone exceeds the limit — a single oversized entry description, nothing left
 * to drop — is it hard-cut at the limit with a bare "…"; the truncated flag
 * lets the views mark it so it can be shortened at the source.
 */
export function fitDescs(descs: string[], maxLen: number | null | undefined): FittedDesc {
  const full = descs.join('; ');
  if (!maxLen || maxLen <= 0 || full.length <= maxLen) {
    return { text: full, truncated: false, full };
  }

  let kept = '';
  for (const part of descs) {
    const candidate = kept ? `${kept}; ${part}` : part;
    // Reserve room for the dropped-marker: we already know the full join
    // doesn't fit, so at least one later part is going to be dropped.
    if (candidate.length + DROPPED.length > maxLen) break;
    kept = candidate;
  }

  if (kept) return { text: kept + DROPPED, truncated: true, full };
  // Even the first part alone is over the limit — cut it mid-text.
  return { text: descs[0].slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…', truncated: true, full };
}
