// The optional external template pack.
//
// `@pdf-template-pack` is an alias, not a package. It resolves to
// `pdf-templates/index.ts` when that file exists (scripts/sync-pack.mjs checks
// the pack out there from PDF_TEMPLATE_PACK_REPO) and to ./emptyPack.ts
// otherwise. Three places define the pair and must agree: next.config.js (the
// bundler), tsconfig.json `paths` (tsc and the editor) and
// scripts/resolve-hooks.mjs (the check scripts).
//
// A pack may rely only on what ./types exports. See README.md → "Private
// template packs".

import pack from '@pdf-template-pack';

export const templatePack = pack;
