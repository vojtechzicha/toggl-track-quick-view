// Module resolution for the scripts/ checks, which run the app's source
// directly under Node's TypeScript support. Adds what the bundler provides:
// `@/…` aliases, extensionless relative imports, and the `@pdf-template-pack`
// alias (see lib/export/pdf/pack.ts). Used by the app's checks and a template
// pack's own. Also pins pdf-lib; see PDF_LIB.

import { registerHooks } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_URL = pathToFileURL(root + path.sep);

/** Must match tsconfig.json `paths` and next.config.js, in the same order. */
const PACK_CANDIDATES = ['pdf-templates/index.ts', 'lib/export/pdf/emptyPack.ts'];

/**
 * A single copy of pdf-lib for the signing checks.
 *
 * `pdf-lib` is an alias for @cantoo/pdf-lib (package.json), whose exports map
 * serves cjs/ to `require` and es/ to `import`. @signpdf/placeholder-pdf-lib
 * requires it and lib/export/pdf/sign imports it, which would load two
 * instances. pdf-lib keys dictionaries by PDFName identity, so the
 * placeholder's /AcroForm would then be invisible to the signing code, failing
 * silently when the appearance is attached. next.config.js pins the bundle the
 * same way.
 *
 * The pin holds only while no `load` hook is registered (see installResolveHooks).
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
 *   serve for specific specifiers (check-fonts.ts stubs pdfmake).
 *
 * The `load` hook is registered only when there are stubs. On Node 22 any load
 * hook makes the ESM loader evaluate imported CommonJS modules itself, and
 * their `require()` calls then skip the resolve hook. The placeholder's
 * `require('pdf-lib')` would get cjs/ and bring back the two-copies failure,
 * so a check that stubs something must not also sign.
 */
export function installResolveHooks({ stubs = {} } = {}) {
  const hasStubs = Object.keys(stubs).length > 0;
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
    ...(hasStubs && {
      load(url, context, next) {
        const key = url.startsWith('stub:') ? url.slice(5) : '';
        if (stubs[key]) return { format: 'module', source: stubs[key], shortCircuit: true };
        return next(url, context);
      },
    }),
  });
}
