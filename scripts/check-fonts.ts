// Checks that the font declarations and the virtual file system agree, for
// every registered template. Run with:
//   npm run check:fonts
//
// pdfmake resolves a font to a filename and then looks that filename up in the
// VFS. When the two disagree it fails at render time, deep inside the library
// ("File 'X.ttf' not found in virtual file system"), and only for documents
// that actually reach the missing glyph. Cheap to assert here.
//
// This exists because the declarations and the data were once passed to pdfmake
// through two different channels — `pdfMake.fonts` (which won its precedence
// chain) and `pdfMake.vfs` (which lost it to a global set by an import side
// effect). The result was a build where fonts were declared but their data was
// not reachable. They now travel together through a template's `loadFonts()`
// and fontConfig().
//
// It is written against the template REGISTRY rather than against any
// particular template, so it covers whatever an external pack contributes
// (lib/export/pdf/pack.ts) without knowing anything about it. A pack that makes
// stricter claims about its own cuts — exact weights, exact names — asserts
// those in its own checks (npm run check:pack).

import assert from 'node:assert/strict';
import { installResolveHooks } from './resolve-hooks.mjs';
import { cmapCodepoints, isFontFile } from './font-introspect.mjs';

// Stubs for the two extensionless specifiers toPDF imports. They reproduce
// pdfmake's precedence chain and the import side effect that broke production;
// the real bundle is still read below via the explicit ".js" specifier.
const STUB = {
  'pdfmake/build/pdfmake': `
    let globalVfs, globalFonts;
    export const calls = [];
    const pdfMake = {
      createPdf(def, layouts, fonts, vfs) {
        // Exactly pdfmake's own resolution order.
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
    // The side effect that caused the bug: it sets globalVfs to the Roboto-only
    // set, which outranks anything later assigned to pdfMake.vfs.
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

// The real pdfmake bundle, resolved exactly as the app resolves it.
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
// One template must render with one merged config, whatever its fonts came
// from. Loading each template's pack here also proves `loadFonts()` resolves at
// all — a pack whose font module has moved fails at export time otherwise.

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

// ---- the embedded cuts themselves ----
//
// One entry per distinct file across every template, so a font pack shared by
// several templates is read once.

const embedded = new Map<string, string>();
for (const pack of packs.values()) {
  for (const [file, b64] of Object.entries(pack.vfs)) embedded.set(file, b64);
}

// One representative per script/block the templates can meet in user text.
// pdfmake has NO per-glyph fallback: any code point an embedded cut lacks
// renders as tofu wherever user-controlled text (project names, descriptions,
// clients) reaches the page. A cut that replaces the document's body font
// therefore has to carry the typeface's whole character map — a Latin-only
// subset once shipped and would have mangled a project named "Миграция".
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
  // Base64 payloads must decode — a truncated paste would still be a string.
  const buf = Buffer.from(b64, 'base64');
  ok(buf.length > 1000, `${file} decodes to a plausible font (${buf.length} bytes)`);
  ok(isFontFile(buf), `${file} decodes to a real TrueType/OpenType file`);

  const cps = cmapCodepoints(buf);
  ok(cps.size >= 800, `${file} keeps the full character map (${cps.size} code points)`);
  for (const [ch, what] of COVERAGE) {
    ok(cps.has(ch.codePointAt(0) as number), `${file} covers "${ch}" — ${what}`);
  }
}

// ---- the production regression itself ----
//
// Renders through the real toPDF against a pdfmake stub that reproduces both the
// precedence chain and the import side effect. Assigning pdfMake.vfs (the old
// approach) loses to globalVfs here, exactly as it did in the deployed bundle;
// passing the vfs to createPdf wins.

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
    // The declarations and the data must still agree at the point of the call.
    assertComplete(`toPDF ${tpl.id}`, { fonts, vfs });
    for (const file of Object.keys(packs.get(tpl.id)?.vfs ?? {})) {
      ok(
        typeof vfs[file] === 'string',
        `${tpl.id}: the embedded cut ${file} survives the Roboto-only globalVfs — the exact ` +
          'production failure this guards'
      );
    }
  }
}

console.log(`✓ ${checks} font/VFS checks passed (${PDF_TEMPLATES.length} templates, ${embedded.size} embedded cuts)`);
