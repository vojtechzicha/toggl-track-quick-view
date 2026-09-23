// Build id for the post-deploy refresh hint (components/UpdateHint.tsx),
// inlined into the client bundle and the server routes so a tab can compare
// its id with GET /api/version.
//
// Must be deterministic: Next evaluates this config several times per build,
// and a random id would differ between bundles and make every tab look stale.
// On Vercel the commit comes from VERCEL_GIT_COMMIT_SHA (no .git in the build).
// Without a commit, 'unversioned' turns the hint off.
function computeBuildId() {
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercelSha) return vercelSha.slice(0, 16);
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, 16);
  } catch {
    return 'unversioned';
  }
}

const buildId = computeBuildId();

// lib/export/pdf/sign and @signpdf/placeholder-pdf-lib must share one copy of
// pdf-lib. `pdf-lib` is already an alias for @cantoo/pdf-lib (package.json),
// but the placeholder `require`s it while our code `import`s it, and the
// exports map serves those from different builds (cjs/ vs es/). pdf-lib keys
// dictionaries by PDFName identity, so with two copies the placeholder's
// /AcroForm and /Annots entries are unreadable to our code. Pinning both
// specifiers to the ES build fixes that. scripts/resolve-hooks.mjs does the
// same for the check scripts.
const pdfLibEsm = require('path').join(
  require('path').dirname(require.resolve('@cantoo/pdf-lib')),
  '../es/index.js'
);

// The optional PDF template pack (lib/export/pdf/pack.ts), checked out into
// pdf-templates/ by scripts/sync-pack.mjs. Without it, fall back to the empty
// pack. The same pair is in tsconfig.json `paths` and scripts/resolve-hooks.mjs;
// keep all three in step.
const PACK_ENTRY = require('path').join(__dirname, 'pdf-templates', 'index.ts');
const templatePack = require('fs').existsSync(PACK_ENTRY)
  ? PACK_ENTRY
  : require('path').join(__dirname, 'lib', 'export', 'pdf', 'emptyPack.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  generateBuildId: () => buildId,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
    // For the installed app's name (lib/pwa.ts): previews install as "(beta)".
    // Set here so it works without Vercel's system-variable exposure; empty
    // outside Vercel.
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? '',
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'pdf-lib$': pdfLibEsm,
      '@cantoo/pdf-lib$': pdfLibEsm,
      '@pdf-template-pack': templatePack,
    };
    return config;
  },
};

module.exports = nextConfig;
