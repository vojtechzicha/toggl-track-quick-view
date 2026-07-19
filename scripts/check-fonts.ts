// Checks that the font declarations and the virtual file system agree. Run with:
//   npm run check:fonts
//
// pdfmake resolves a font to a filename and then looks that filename up in the
// VFS. When the two disagree it fails at render time, deep inside the library
// ("File 'Fraunces-SemiBold.ttf' not found in virtual file system"), and only
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
const { reportVfs, reportFonts } = await import('../lib/export/pdf/reportFonts.ts');
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

// The report fontset: Roboto must survive alongside the embedded cuts.
{
  const cfg = fontConfig(baseVfs, { reportVfs, reportFonts });
  assertComplete('report fontset', cfg);
  ok(cfg.fonts.Roboto != null, 'declaring custom fonts must not drop Roboto');
  ok(cfg.fonts.Fraunces != null, 'the report declares Fraunces');
  ok(cfg.fonts.IBMPlexMono != null, 'the report declares IBM Plex Mono');
  // The exact file the production failure named.
  ok(
    typeof cfg.vfs['Fraunces-SemiBold.ttf'] === 'string' &&
      cfg.vfs['Fraunces-SemiBold.ttf'].length > 1000,
    'Fraunces-SemiBold.ttf is present with real data'
  );
  // Embedded cuts must not be shadowed by, or shadow, the base bundle.
  for (const file of Object.keys(reportVfs)) {
    ok(cfg.vfs[file] === reportVfs[file], `${file} survives the merge intact`);
  }
  for (const file of Object.keys(baseVfs)) {
    ok(cfg.vfs[file] != null, `base font ${file} survives the merge`);
  }
}

// Every registered template must declare a fontset it can actually render with.
for (const tpl of PDF_TEMPLATES) {
  const cfg = fontConfig(baseVfs, tpl.fontset === 'report' ? { reportVfs, reportFonts } : null);
  assertComplete(`template ${tpl.id}`, cfg);
}

// Base64 payloads must decode — a truncated paste would still be a string.
for (const [file, b64] of Object.entries(reportVfs)) {
  const buf = Buffer.from(b64, 'base64');
  ok(buf.length > 1000, `${file} decodes to a plausible font (${buf.length} bytes)`);
  // TrueType/OpenType magic: 0x00010000 or "OTTO" or "true".
  const magic = buf.subarray(0, 4).toString('hex');
  ok(
    magic === '00010000' || magic === '4f54544f' || magic === '74727565',
    `${file} decodes to a real font file (magic ${magic})`
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
    if (tpl.fontset === 'report') {
      ok(
        typeof vfs['Fraunces-SemiBold.ttf'] === 'string',
        `${tpl.id}: the embedded cuts survive the Roboto-only globalVfs — the exact ` +
          'production failure this guards'
      );
    }
  }
}

console.log(`✓ ${checks} font/VFS checks passed`);
