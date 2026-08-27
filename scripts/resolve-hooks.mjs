// Module resolution for the scripts/ checks.
//
// They run straight through Node's TypeScript support, against source written
// for a bundler: `@/…` aliases, extensionless relative imports, and the
// `@pdf-template-pack` alias with its fallback list (see lib/export/pdf/pack.ts).
// Node resolves none of those on its own, so they are patched in here — once,
// and identically for the app's checks and for a template pack's own.
//
// pdf-lib is pinned here too, and that one is load-bearing rather than
// cosmetic: see PDF_LIB below.

import { registerHooks } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_URL = pathToFileURL(root + path.sep);

/** Same pair, in the same order, as tsconfig.json and next.config.js. */
const PACK_CANDIDATES = ['pdf-templates/index.ts', 'lib/export/pdf/emptyPack.ts'];

/**
 * ONE copy of pdf-lib, for the signing checks.
 *
 * `pdf-lib` is an ALIAS for @cantoo/pdf-lib (package.json), and its exports map
 * answers `require` with cjs/ and `import` with es/. @signpdf/placeholder-pdf-lib
 * requires it while lib/export/pdf/sign imports it, so the two halves would get
 * two module instances — two PDFName pools, two PDFDict classes — and pdf-lib
 * keys dictionaries by PDFName IDENTITY, so the placeholder's /AcroForm would be
 * invisible to the code that has to find it. It fails silently, at the point
 * where the appearance is attached. next.config.js pins the bundle the same way.
 */
const PDF_LIB = pathToFileURL(
  path.join(root, 'node_modules/@cantoo/pdf-lib/es/index.js')
).href;

/** Absolute path of the template pack entry a check will actually load. */
export function packEntry() {
  for (const candidate of PACK_CANDIDATES) {
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * @param {{stubs?: Record<string, string>}} [opts] In-memory module sources to
 *   serve instead of resolving a specifier — check-fonts.ts stubs pdfmake with
 *   one that records what it was called with.
 */
export function installResolveHooks({ stubs = {} } = {}) {
  registerHooks({
    resolve(specifier, context, next) {
      if (stubs[specifier]) {
        return { url: `stub:${specifier}`, format: 'module', shortCircuit: true };
      }
      if (specifier === 'pdf-lib' || specifier === '@cantoo/pdf-lib') {
        return { url: PDF_LIB, shortCircuit: true };
      }
      // pdfmake's browser bundle, as lib/export/pdf/index.ts asks for it.
      if (specifier.startsWith('pdfmake/build/') && !specifier.endsWith('.js')) {
        return next(`${specifier}.js`, context);
      }
      if (specifier === '@pdf-template-pack') {
        const entry = packEntry();
        if (entry) return { url: pathToFileURL(entry).href, shortCircuit: true };
      }
      if (specifier.startsWith('@/')) {
        return { url: new URL(specifier.slice(2) + '.ts', ROOT_URL).href, shortCircuit: true };
      }
      // Next resolves extensionless relative imports; node needs them spelled out.
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
        for (const ext of ['.ts', '.tsx', '/index.ts']) {
          const u = new URL(specifier + ext, context.parentURL);
          if (fs.existsSync(u)) return { url: u.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      const key = url.startsWith('stub:') ? url.slice(5) : '';
      if (stubs[key]) return { format: 'module', source: stubs[key], shortCircuit: true };
      return next(url, context);
    },
  });
}
