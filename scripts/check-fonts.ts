// Checks that the font declarations and the virtual file system agree. Run with:
//   npm run check:fonts
//
// pdfmake resolves a font to a filename and then looks that filename up in the
// VFS. When the two disagree it fails at render time, deep inside the library
// ("File 'IBMPlexSans-SemiBold.ttf' not found in virtual file system"), and only
// for documents that actually reach the missing glyph. Cheap to assert here.
//
// This exists because the declarations and the data were once passed to pdfmake
// through two different channels — `pdfMake.fonts` (which won its precedence
// chain) and `pdfMake.vfs` (which lost it to a global set by an import side
// effect). The result was a build where fonts were declared but their data was
// not reachable. They now travel together through fontConfig().

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);

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

registerHooks({
  resolve(specifier, context, next) {
    if (STUB[specifier]) {
      return { url: `stub:${specifier}`, format: 'module', shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return { url: new URL(specifier.slice(2) + '.ts', ROOT).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(u)) return { url: u.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const key = url.startsWith('stub:') ? url.slice(5) : '';
    if (STUB[key]) return { format: 'module', source: STUB[key], shortCircuit: true };
    return next(url, context);
  },
});

const { fontConfig, resolveBaseVfs } = await import('../lib/export/pdf/index.ts');
const { identityVfs, identityFonts } = await import('../lib/export/pdf/identityFonts.ts');
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
function assertComplete(label: string, cfg: { fonts: Record<string, Record<string, string>>; vfs: Record<string, string> }) {
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
  assertComplete('no fontset', cfg);
  ok(Object.keys(cfg.fonts).length === 1, 'only Roboto is declared without a fontset');
}

// The identity fontset: Roboto must survive alongside the embedded cuts.
{
  const cfg = fontConfig(baseVfs, { identityVfs, identityFonts });
  assertComplete('identity fontset', cfg);
  ok(cfg.fonts.Roboto != null, 'declaring custom fonts must not drop Roboto');
  ok(cfg.fonts.IBMPlexSans != null, 'the identity set declares IBM Plex Sans');
  ok(cfg.fonts.IBMPlexSansMedium != null, 'the identity set declares the Medium/Bold pair');
  // The same failure shape the old production bug had: a declared cut whose
  // data never reaches pdfmake.
  ok(
    typeof cfg.vfs['IBMPlexSans-SemiBold.ttf'] === 'string' &&
      cfg.vfs['IBMPlexSans-SemiBold.ttf'].length > 1000,
    'IBMPlexSans-SemiBold.ttf is present with real data'
  );
  // Embedded cuts must not be shadowed by, or shadow, the base bundle.
  for (const file of Object.keys(identityVfs)) {
    ok(cfg.vfs[file] === identityVfs[file], `${file} survives the merge intact`);
  }
  for (const file of Object.keys(baseVfs)) {
    ok(cfg.vfs[file] != null, `base font ${file} survives the merge`);
  }
}

// Every registered template must declare a fontset it can actually render with.
for (const tpl of PDF_TEMPLATES) {
  const cfg = fontConfig(baseVfs, tpl.fontset === 'identity' ? { identityVfs, identityFonts } : null);
  assertComplete(`template ${tpl.id}`, cfg);
}

// Base64 payloads must decode — a truncated paste would still be a string.
for (const [file, b64] of Object.entries(identityVfs)) {
  const buf = Buffer.from(b64, 'base64');
  ok(buf.length > 1000, `${file} decodes to a plausible font (${buf.length} bytes)`);
  // TrueType/OpenType magic: 0x00010000 or "OTTO" or "true".
  const magic = buf.subarray(0, 4).toString('hex');
  ok(
    magic === '00010000' || magic === '4f54544f' || magic === '74727565',
    `${file} decodes to a real font file (magic ${magic})`
  );
}

// ---- character coverage ----
//
// pdfmake has no per-glyph fallback: any code point an embedded cut lacks
// renders as tofu wherever user-controlled text (project names, descriptions,
// clients) reaches the page. The cuts are generated with the typeface's full
// character map, and this asserts it stays that way across regenerations —
// a Latin-only subset once shipped and would have mangled e.g. a project
// named "Миграция".

/** Code points mapped by a TrueType font — a minimal cmap reader (formats 4 and 12). */
function cmapCodepoints(font: Buffer): Set<number> {
  const numTables = font.readUInt16BE(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) === 'cmap') {
      cmapOff = font.readUInt32BE(rec + 8);
      break;
    }
  }
  assert.ok(cmapOff >= 0, 'font has a cmap table');
  const nSub = font.readUInt16BE(cmapOff + 2);
  const out = new Set<number>();
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = font.readUInt16BE(rec);
    const encoding = font.readUInt16BE(rec + 2);
    // Unicode subtables only: platform 0, or Microsoft BMP/full (3,1) / (3,10).
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const sub = cmapOff + font.readUInt32BE(rec + 4);
    const format = font.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = font.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2; s += 2) {
        const end = font.readUInt16BE(ends + s);
        const start = font.readUInt16BE(starts + s);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) out.add(c);
      }
    } else if (format === 12) {
      const nGroups = font.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const grp = sub + 16 + g * 12;
        const start = font.readUInt32BE(grp);
        const end = font.readUInt32BE(grp + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

// One representative per script/block the templates can meet in user text.
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

for (const [file, b64] of Object.entries(identityVfs)) {
  const cps = cmapCodepoints(Buffer.from(b64, 'base64'));
  ok(cps.size >= 800, `${file} keeps the full character map (${cps.size} code points)`);
  for (const [ch, what] of COVERAGE) {
    ok(cps.has(ch.codePointAt(0) as number), `${file} covers "${ch}" — ${what}`);
  }
}

// ---- genuine weights ----
//
// The visible bold hierarchy must come from real SemiBold/Bold outlines, not a
// Regular file mapped under several names. Each cut must carry the weight
// class of the weight it is declared as, and a name table that says so — a PDF
// inspector reading the embedded fonts should see the genuine cut.

function sfntTable(font: Buffer, tag: string): number {
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) === tag) return font.readUInt32BE(rec + 8);
  }
  return -1;
}

/** OS/2 usWeightClass — 400 regular, 500 medium, 600 semibold, 700 bold. */
function weightClass(font: Buffer): number {
  const os2 = sfntTable(font, 'OS/2');
  assert.ok(os2 >= 0, 'font has an OS/2 table');
  return font.readUInt16BE(os2 + 4);
}

/** The full font name (name ID 4) from a Unicode/Microsoft name record. */
function fullName(font: Buffer): string {
  const nameOff = sfntTable(font, 'name');
  assert.ok(nameOff >= 0, 'font has a name table');
  const count = font.readUInt16BE(nameOff + 2);
  const strings = nameOff + font.readUInt16BE(nameOff + 4);
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platform = font.readUInt16BE(rec);
    const nameId = font.readUInt16BE(rec + 6);
    if (nameId !== 4 || !(platform === 0 || platform === 3)) continue;
    const len = font.readUInt16BE(rec + 8);
    const off = strings + font.readUInt16BE(rec + 10);
    // Unicode name strings are UTF-16BE.
    let out = '';
    for (let b = 0; b < len; b += 2) out += String.fromCharCode(font.readUInt16BE(off + b));
    return out;
  }
  return '';
}

const EXPECTED_CUTS: Record<string, { weight: number; name: string }> = {
  'IBMPlexSans-Regular.ttf': { weight: 400, name: 'IBM Plex Sans Regular' },
  'IBMPlexSans-Medium.ttf': { weight: 500, name: 'IBM Plex Sans Medium' },
  'IBMPlexSans-SemiBold.ttf': { weight: 600, name: 'IBM Plex Sans SemiBold' },
  'IBMPlexSans-Bold.ttf': { weight: 700, name: 'IBM Plex Sans Bold' },
  'IBMPlexSans-Italic.ttf': { weight: 400, name: 'IBM Plex Sans Italic' },
};
eqKeys: {
  const have = Object.keys(identityVfs).sort();
  const want = Object.keys(EXPECTED_CUTS).sort();
  ok(
    have.length === want.length && have.every((f, i) => f === want[i]),
    `the identity VFS ships exactly the expected cuts (${have.join(', ')})`
  );
  break eqKeys;
}
for (const [file, expect] of Object.entries(EXPECTED_CUTS)) {
  const buf = Buffer.from(identityVfs[file], 'base64');
  ok(
    weightClass(buf) === expect.weight,
    `${file} is genuinely weight ${expect.weight} (got ${weightClass(buf)})`
  );
  ok(
    fullName(buf) === expect.name,
    `${file} identifies itself as "${expect.name}" (got "${fullName(buf)}")`
  );
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
    if (tpl.fontset === 'identity') {
      ok(
        typeof vfs['IBMPlexSans-SemiBold.ttf'] === 'string',
        `${tpl.id}: the embedded cuts survive the Roboto-only globalVfs — the exact ` +
          'production failure this guards'
      );
    }
  }
}

console.log(`✓ ${checks} font/VFS checks passed`);
