// Some clients' timesheet systems reject descriptions over N characters, so an
// optional per-workspace limit applies to every merged description. The views,
// copy buttons and exports all use fitDescs, so they emit the same text.

/** A merged description after the optional length limit has been applied. */
export interface FittedDesc {
  /** The text to display, copy and export. Never longer than the limit. */
  text: string;
  /** True when anything was dropped or cut. */
  truncated: boolean;
  /** The untruncated join, for the tooltip showing what was dropped. */
  full: string;
}

/** The marker appended when whole description parts were dropped. */
const DROPPED = '; …';

/**
 * Join description parts with "; " and fit the result within `maxLen`
 * characters (null or 0 means no limit).
 *
 * Over the limit, whole parts are kept in order while they fit and the rest is
 * replaced by "; …". Earlier parts win, so a linked-code cell keeps its
 * per-code breakdown (its first part). If the first part alone is too long, it
 * is cut at the limit and ends in "…".
 */
export function fitDescs(descs: string[], maxLen: number | null | undefined): FittedDesc {
  const full = descs.join('; ');
  if (!maxLen || maxLen <= 0 || full.length <= maxLen) {
    return { text: full, truncated: false, full };
  }

  let kept = '';
  for (const part of descs) {
    const candidate = kept ? `${kept}; ${part}` : part;
    // Leave room for the marker: the full join does not fit, so something
    // will be dropped.
    if (candidate.length + DROPPED.length > maxLen) break;
    kept = candidate;
  }

  if (kept) return { text: kept + DROPPED, truncated: true, full };
  // The first part alone is too long: cut it.
  return { text: descs[0].slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…', truncated: true, full };
}
