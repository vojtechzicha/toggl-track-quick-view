// Checks that font declarations and the virtual file system agree for every
// registered template, pack included (`pnpm check:fonts`).
//
// pdfmake looks each declared font file up in the VFS; a missing one fails at
// render time ("File 'X.ttf' not found in virtual file system"), and only for
// documents that use that font. It also guards a production bug where the
// vfs lost pdfmake's precedence chain to a global set by an import side
// effect (see renderPdfMake in lib/export/pdf/index.ts).
//
// Pack-specific claims (exact weights, names) belong in the pack's own checks
// (`pnpm check:pack`).

import assert from 'node:assert/strict';
import { installResolveHooks } from './resolve-hooks.mjs';
import { cmapCodepoints, isFontFile } from './font-introspect.mjs';

// Stubs for the two specifiers toPDF imports, reproducing pdfmake's precedence
// chain and the import side effect. The real bundle is read below via ".js".
const STUB = {
  'pdfmake/build/pdfmake': `
    let globalVfs, globalFonts;
    export const calls = [];
    const pdfMake = {
      createPdf(def, layouts, fonts, vfs) {
        // pdfmake's resolution order.
        calls.push({
          fonts: fonts || globalFonts || pdfMake.fonts,
          vfs: vfs || globalVfs || pdfMake.vfs,
        });
        return { getBlob: (cb) => cb(new Blob([])) };
      },
      addVirtualFileSystem(v) { globalVfs = v; },
    };
    export default pdfMake;
  `,
  'pdfmake/build/vfs_fonts': `
    import pdfMake from 'pdfmake/build/pdfmake';
    const vfs = { 'Roboto-Regular.ttf': 'Uk9CT1RP', 'Roboto-Medium.ttf': 'Uk9CT1RP',
                  'Roboto-Italic.ttf': 'Uk9CT1RP', 'Roboto-MediumItalic.ttf': 'Uk9CT1RP' };
    // The side effect: sets globalVfs to the Roboto-only set, which outranks
    // pdfMake.vfs.
    if (pdfMake && pdfMake.addVirtualFileSystem) pdfMake.addVirtualFileSystem(vfs);
    export default vfs;
  `,
} as Record<string, string>;

installResolveHooks({ stubs: STUB });

const { fontConfig, resolveBaseVfs } = await import('../lib/export/pdf/fonts.ts');
const { PDF_TEMPLATES } = await import('../lib/export/pdf/templates.ts');

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};

// The real pdfmake bundle.
const baseVfs = resolveBaseVfs(await import('pdfmake/build/vfs_fonts.js'));
ok(Object.keys(baseVfs).length > 0, 'pdfmake ships a base VFS we can read');
ok(typeof baseVfs['Roboto-Regular.ttf'] === 'string', 'the base VFS carries Roboto');

/** Every file named by a declaration must be present, and non-empty, in the VFS. */
function assertComplete(
  label: string,
  cfg: { fonts: Record<string, Record<string, string>>; vfs: Record<string, string> }
) {
  for (const [family, cuts] of Object.entries(cfg.fonts)) {
    for (const [cut, file] of Object.entries(cuts)) {
      const data = cfg.vfs[file];
      ok(
        typeof data === 'string' && data.length > 0,
        `${label}: ${family}.${cut} needs "${file}", which must exist in the VFS`
      );
    }
  }
}

// Templates without their own typography: Roboto only, and it must be complete.
{
  const cfg = fontConfig(baseVfs, null);
  assertComplete('no extra fonts', cfg);
  ok(Object.keys(cfg.fonts).length === 1, 'only Roboto is declared without a font pack');
}

// ---- what every template declares ----
//
// Also proves each `loadFonts()` resolves; a moved font module would otherwise
// fail only at export time.

const packs = new Map<string, { vfs: Record<string, string>; fonts: Record<string, Record<string, string>> }>();

for (const tpl of PDF_TEMPLATES) {
  const extra = tpl.loadFonts ? await tpl.loadFonts() : null;
  const cfg = fontConfig(baseVfs, extra);
  assertComplete(`template ${tpl.id}`, cfg);
  ok(cfg.fonts.Roboto != null, `${tpl.id}: declaring custom fonts must not drop Roboto`);
  if (!extra) continue;

  packs.set(tpl.id, extra);
  // Embedded cuts must not be shadowed by, or shadow, the base bundle.
  for (const file of Object.keys(extra.vfs)) {
    ok(cfg.vfs[file] === extra.vfs[file], `${tpl.id}: ${file} survives the merge intact`);
  }
  for (const file of Object.keys(baseVfs)) {
    ok(cfg.vfs[file] != null, `${tpl.id}: base font ${file} survives the merge`);
  }
}

// ---- the embedded font files ----
//
// Each distinct file once, even when shared by several templates.

const embedded = new Map<string, string>();
for (const pack of packs.values()) {
  for (const [file, b64] of Object.entries(pack.vfs)) embedded.set(file, b64);
}

// One sample per script or block that user text may contain. pdfmake has no
// glyph fallback, so a code point missing from an embedded font renders as a
// blank box wherever user text (project names, descriptions, clients) appears.
// Embedded fonts must keep their full character map, not a Latin subset.
const COVERAGE: Array<[string, string]> = [
  ['ř', 'Czech diacritics (Latin Ext-A)'],
  ['ě', 'Czech diacritics (Latin Ext-A)'],
  ['ị', 'Vietnamese (Latin Ext Additional)'],
  ['Ж', 'Cyrillic uppercase'],
  ['я', 'Cyrillic lowercase'],
  ['λ', 'Greek'],
  ['€', 'currency symbols'],
  ['№', 'letterlike symbols'],
  ['→', 'arrows'],
  ['≤', 'math operators'],
  ['„', 'Czech quotation marks'],
  ['–', 'en dash'],
];

for (const [file, b64] of embedded) {
  // A truncated base64 payload is still a string; check it decodes to a font.
  const buf = Buffer.from(b64, 'base64');
  ok(buf.length > 1000, `${file} decodes to a plausible font (${buf.length} bytes)`);
  ok(isFontFile(buf), `${file} decodes to a real TrueType/OpenType file`);

  const cps = cmapCodepoints(buf);
  ok(cps.size >= 800, `${file} keeps the full character map (${cps.size} code points)`);
  for (const [ch, what] of COVERAGE) {
    ok(cps.has(ch.codePointAt(0) as number), `${file} covers "${ch}" — ${what}`);
  }
}

// ---- the production regression ----
//
// Renders through the real toPDF against the stub. Assigning pdfMake.vfs would
// lose to globalVfs here, as it did in production; passing the vfs to
// createPdf wins.

{
  const { toPDF } = await import('../lib/export/pdf/index.ts');
  const { calls } = (await import('pdfmake/build/pdfmake')) as unknown as {
    calls: Array<{ fonts: Record<string, Record<string, string>>; vfs: Record<string, string> }>;
  };

  const doc = {
    view: 'individual' as const,
    title: 'Alpha Platform',
    personName: 'Jan Novák',
    role: '',
    company: '',
    client: 'Example Client s.r.o.',
    approver: '',
    reference: 'TS-2026-07',
    engagement: '',
    rate: null,
    currency: '',
    fromMs: new Date(2026, 6, 1).getTime(),
    toMs: new Date(2026, 7, 1).getTime(),
    multi: false,
    billByProject: false,
    days: [],
    grandTotal: 0,
  };

  for (const tpl of PDF_TEMPLATES) {
    calls.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toPDF(doc as any, tpl.id);
    ok(calls.length === 1, `${tpl.id}: reached createPdf once`);
    const { fonts, vfs } = calls[0];
    ok(vfs != null, `${tpl.id}: a VFS reached pdfmake despite the global side effect`);
    // Declarations and data must agree at the call.
    assertComplete(`toPDF ${tpl.id}`, { fonts, vfs });
    for (const file of Object.keys(packs.get(tpl.id)?.vfs ?? {})) {
      ok(
        typeof vfs[file] === 'string',
        `${tpl.id}: the embedded font ${file} survives the Roboto-only globalVfs ` +
          '(the production regression)'
      );
    }
  }
}

console.log(`✓ ${checks} font/VFS checks passed (${PDF_TEMPLATES.length} templates, ${embedded.size} embedded cuts)`);
