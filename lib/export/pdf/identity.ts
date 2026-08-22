// Shared vocabulary of the Vojtěch Zicha visual identity for the PDF templates
// (canonical spec: "Visual Identity Design System v1.0", Design.md). Everything
// here is a *behaviour* of that system — the palette, the rule grammar, the
// signature form — so the templates compose documents from it instead of each
// inventing decoration. Templates using this module set `fontset: 'identity'`
// (IBM Plex Sans, see identityFonts.ts).

import type { CanvasLine, Content } from 'pdfmake/interfaces';

// ---- palette (§6.1) ----

export const VZ = {
  /** Primary text and rules. */
  ink: '#1A1C1E',
  /** Secondary text, metadata. */
  secondary: '#575C61',
  /** The identity accent — used rarely and semantically (§6.3). */
  oxide: '#8C3520',
  paper: '#FFFFFF',
  /** Hairlines and borders; decorative only, never text. */
  rule: '#E2E4E6',
  /** Functional fill for table heads and summary bands — never decorative. */
  surface: '#F5F6F7',
};

// ---- fonts ----

// The two pdfmake families of identityFonts.ts. The base family carries the
// system's main axis (Regular 400 body, SemiBold 600 via `bold`); the second
// carries Medium 500 labels (Bold 700 via `bold`).
export const F = {
  sans: 'IBMPlexSans',
  medium: 'IBMPlexSansMedium',
};

// ---- layout (§8) ----

/** A4 margins: 22 mm left/right, 20 mm top, 18 mm bottom (with footer room). */
export const A4_MARGINS: [number, number, number, number] = [62, 57, 62, 66];
/** Printable width of an A4 portrait page inside those margins. */
export const CW_PORTRAIT = 595.28 - 2 * 62;
/** Printable width of an A4 landscape page inside those margins. */
export const CW_LANDSCAPE = 841.89 - 2 * 62;

// ---- rule grammar (§7) ----

/** Oxide termination: the final 7 mm of a principal rule's thick stroke. */
const TERMINUS = 20;

/**
 * Principal double rule (1 pt stroke, 0.7 pt gap, 0.3 pt stroke). With
 * `oxide`, the last 7 mm of the thick stroke terminate in Oxide — the
 * signature-level treatment, at most once per page (§7). Never edge-to-edge:
 * pass a deliberate length (60–80 mm ≈ 170–227 pt, or the text measure).
 */
export function principalRule(width: number, oxide: boolean, margin: [number, number, number, number]): Content {
  const thick: CanvasLine[] = oxide
    ? [
        { type: 'line', x1: 0, y1: 0.5, x2: width - TERMINUS, y2: 0.5, lineWidth: 1, lineColor: VZ.ink },
        { type: 'line', x1: width - TERMINUS, y1: 0.5, x2: width, y2: 0.5, lineWidth: 1, lineColor: VZ.oxide },
      ]
    : [{ type: 'line', x1: 0, y1: 0.5, x2: width, y2: 0.5, lineWidth: 1, lineColor: VZ.ink }];
  return {
    canvas: [
      ...thick,
      { type: 'line', x1: 0, y1: 1.85, x2: width, y2: 1.85, lineWidth: 0.3, lineColor: VZ.ink },
    ],
    margin,
  };
}

/** Full rule, 0.5 pt Ink — table heads and strong structural divisions. */
export function fullRule(width: number, margin: [number, number, number, number]): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0.25, x2: width, y2: 0.25, lineWidth: 0.5, lineColor: VZ.ink }],
    margin,
  };
}

/** Hairline, 0.3 pt Rule grey — ordinary divisions. */
export function hairline(width: number, margin: [number, number, number, number]): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0.15, x2: width, y2: 0.15, lineWidth: 0.3, lineColor: VZ.rule }],
    margin,
  };
}

// ---- the signature (§3) ----

/**
 * The signature form: the name with its terminal full stop in Oxide. Used only
 * where the name *signs* the work (mastheads, signature blocks); factual
 * mentions stay plain. The dot is the same size as the name, never detached; a
 * name already ending in "." keeps a single dot (it turns oxide).
 */
export function signature(name: string, opts: { style?: string; alignment?: 'left' | 'right'; margin?: [number, number, number, number] } = {}): Content {
  const trimmed = name.trim().replace(/\.$/, '');
  if (!trimmed) return { text: '', ...opts };
  return {
    text: [{ text: trimmed }, { text: '.', color: VZ.oxide }],
    ...opts,
  };
}

// ---- table layouts ----

/**
 * The identity table: a full rule above and below the head, hairline row
 * separators, a full rule closing the table, no vertical lines, no zebra.
 * Head fill is functional Surface (§6.1). Row padding keeps the professional
 * density of §8.
 */
export function ruledTableLayout(opts: { headFill?: boolean; totalRow?: boolean } = {}) {
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) => {
      const last = node.table.body.length;
      if (i === 0 || i === 1 || i === last) return 0.5;
      // A closing total row separates from the body with a full rule.
      if (opts.totalRow && i === last - 1) return 0.5;
      return 0.3;
    },
    hLineColor: (i: number, node: { table: { body: unknown[] } }) => {
      const last = node.table.body.length;
      if (i === 0 || i === 1 || i === last || (opts.totalRow && i === last - 1)) return VZ.ink;
      return VZ.rule;
    },
    vLineWidth: () => 0,
    fillColor: (rowIndex: number) => (opts.headFill !== false && rowIndex === 0 ? VZ.surface : null),
    paddingTop: () => 3.5,
    paddingBottom: () => 3.5,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

// ---- footer ----

/**
 * Document footer on the bottom margin line, above a hairline (§8): left text
 * 6.5 pt Secondary, right "n/N" in tabular figures.
 */
export function identityFooter(contentWidth: number, left: string) {
  return (currentPage: number, pageCount: number): Content => ({
    margin: [62, 10, 62, 0],
    stack: [
      hairline(contentWidth, [0, 0, 0, 4]),
      {
        columns: [
          { text: left, style: 'vzFooter', alignment: 'left' },
          { text: `${currentPage}/${pageCount}`, style: 'vzFooter', alignment: 'right' },
        ],
      },
    ],
  });
}

// ---- shared styles ----

/**
 * Styles every identity template starts from (print scale, §5.4). `bold: true`
 * on the base family renders SemiBold 600; the medium family's plain cut is
 * Medium 500 and its bold is Bold 700.
 */
export const identityBaseStyles = {
  /** Signature masthead next to a document title. */
  vzSignature: { fontSize: 8.5, bold: true, color: VZ.ink },
  /** Document title, 14 pt SemiBold. */
  vzDocTitle: { fontSize: 14, bold: true, color: VZ.ink },
  /** Metadata label above a value: 7 pt Medium Secondary. */
  vzMetaK: { font: F.medium, fontSize: 7, color: VZ.secondary },
  /** Metadata value: 7.5 pt SemiBold. */
  vzMetaV: { fontSize: 7.5, bold: true, color: VZ.ink },
  /** Table head: 7 pt Bold Secondary. */
  vzTh: { font: F.medium, fontSize: 7, bold: true, color: VZ.secondary },
  /** Table body text. */
  vzTd: { fontSize: 8.5, color: VZ.ink },
  /** Muted table body text. */
  vzTdMuted: { fontSize: 8.5, color: VZ.secondary },
  /** Footnote / legal line. */
  vzFooter: { fontSize: 6.5, color: VZ.secondary },
} as const;

/** Default style for identity templates. */
export const identityDefaultStyle = { font: F.sans, fontSize: 9.5, color: VZ.ink };
