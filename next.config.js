// Build id for the post-deploy refresh hint (see components/UpdateHint.tsx):
// the id is inlined into both the client bundle and the server route handlers
// via `env`, so a long-lived tab can compare its own id against GET
// /api/version and learn that a newer build has been deployed.
//
// It must be DETERMINISTIC — Next evaluates this config several times during
// one build (main process + compiler workers), so a random id would come out
// different in the client bundle, the server bundle, and BUILD_ID, making
// every fresh tab look stale. Deriving it from the git commit makes all
// evaluations agree and gives every deploy of new code a new id. On Vercel
// the commit arrives via VERCEL_GIT_COMMIT_SHA (no .git dir in the build);
// locally, git itself answers. With neither (e.g. a tarball build) it falls
// back to a constant, which simply disables the hint rather than misfiring.
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  generateBuildId: () => buildId,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

module.exports = nextConfig;
