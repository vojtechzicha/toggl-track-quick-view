// The optional external template pack.
//
// `@pdf-template-pack` is an ALIAS, not a package: it resolves to
// `pdf-templates/index.ts` when that directory exists (scripts/sync-pack.mjs
// puts it there, from the repository named by PDF_TEMPLATE_PACK_REPO) and to
// ./emptyPack.ts when it does not. The choice is made once, at config load, by
// next.config.js for the app and by the tsconfig `paths` fallback list for tsc
// and the editor — so a clone with no pack compiles, builds and runs with the
// app's own templates and nothing missing.
//
// Everything a pack may rely on is exported from ./types; nothing in the app
// imports a pack module directly. See README.md → "Private template packs".

import pack from '@pdf-template-pack';

export const templatePack = pack;
