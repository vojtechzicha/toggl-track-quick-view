#!/usr/bin/env node
// Checks out the optional PDF template pack into pdf-templates/.
//
// Runs before `next dev` and `next build` (see package.json). With no pack
// configured it prints one line and exits 0; the app then offers only its own
// Timesheet template (lib/export/pdf/emptyPack.ts).
//
// The directory, not the variable, decides what is compiled in: the
// `@pdf-template-pack` alias resolves to pdf-templates/index.ts if it exists.
// PDF_TEMPLATE_PACK_REPO only controls what is fetched. Unsetting it stops
// updates but keeps the checkout; this script never deletes one, since it
// can't tell its own checkout from a hand-made one. Remove a pack with
// `rm -rf pdf-templates`.
//
// Not a git submodule: .gitmodules would make every clone and fork try to
// fetch the private pack and fail.
//
// A configured pack that cannot be fetched fails the build. Otherwise the
// deploy would succeed without the templates the deployment relies on.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadDotEnv } from './load-env.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(root, 'pdf-templates');
const ENTRY = path.join(DIR, 'index.ts');

loadDotEnv(root);

const repo = (process.env.PDF_TEMPLATE_PACK_REPO ?? '').trim();
const ref = (process.env.PDF_TEMPLATE_PACK_REF ?? '').trim() || 'main';
const token = (process.env.PDF_TEMPLATE_PACK_TOKEN ?? '').trim();

const say = (msg) => console.log(`pdf-pack  ${msg}`);
const die = (msg) => {
  console.error(`pdf-pack  ERROR  ${msg}`);
  process.exit(1);
};

/**
 * The URL passed to git. A token is added to https remotes; ssh remotes are
 * left alone. Never log it; log `redact(url)`.
 */
function authUrl(url) {
  if (!token || !url.startsWith('https://')) return url;
  return url.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

const redact = (url) => url.replace(/\/\/[^@/]+@/, '//***@');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd ?? root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // Never prompt for credentials; a prompt would hang a CI build.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
}

/** Fetch `ref` — branch, tag or commit — and check it out detached. */
function fetchInto(dir, url) {
  git(['fetch', '--depth', '1', '--force', authUrl(url), ref], { cwd: dir });
  git(['checkout', '--force', '--detach', 'FETCH_HEAD'], { cwd: dir });
}

/** Short sha of whatever is checked out, for the log line. */
function headSha(dir) {
  try {
    return git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Whether a failed fetch looks like a network problem. Offline, an existing
 * checkout is still used; a bad ref or token is a configuration error and
 * fails.
 */
const isNetworkError = (detail) =>
  /could not resolve host|couldn't resolve host|connection (refused|reset|closed|timed out)|operation timed out|network is unreachable|no route to host|failed to connect|temporary failure in name resolution|kex_exchange|timed out/i.test(
    detail
  );

// ---- no pack configured: the default ----

if (!repo) {
  if (existsSync(ENTRY)) {
    say(`PDF_TEMPLATE_PACK_REPO is not set, but pdf-templates/ (${headSha(DIR)}) exists and`);
    say('will be compiled in. Delete it to build without a pack.');
  } else {
    say('no template pack configured; using the built-in Timesheet template.');
  }
  process.exit(0);
}

// ---- a checkout that is not ours: leave it alone ----

if (existsSync(DIR) && !existsSync(path.join(DIR, '.git'))) {
  if (!existsSync(ENTRY)) {
    die(
      `pdf-templates/ exists but is not a git checkout and has no index.ts. ` +
        'Remove it, or unset PDF_TEMPLATE_PACK_REPO and manage it by hand.'
    );
  }
  say('pdf-templates/ has no .git; treating it as hand-managed and leaving it alone.');
  process.exit(0);
}

// ---- update or clone ----

const existing = existsSync(path.join(DIR, '.git'));

try {
  // `init` + `fetch <ref>` rather than `clone --branch`, so `ref` can be a
  // branch, a tag or a commit.
  if (!existing) {
    mkdirSync(DIR, { recursive: true });
    git(['init', '--quiet', DIR]);
  }
  fetchInto(DIR, repo);
} catch (err) {
  const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' ');
  if (existing && existsSync(ENTRY) && isNetworkError(detail)) {
    // Offline: keep the existing checkout. Other failures are configuration
    // errors and fall through to die().
    say(`could not reach ${redact(repo)} (${detail})`);
    say(`using the existing checkout (${headSha(DIR)}), which may not match ${ref}.`);
    process.exit(0);
  }
  if (!existing) rmSync(DIR, { recursive: true, force: true });
  die(
    `could not check out ${redact(repo)} at ${ref}: ${detail}\n` +
      '          PDF_TEMPLATE_PACK_REPO is set, so the build needs the pack. Fix the URL,\n' +
      '          PDF_TEMPLATE_PACK_REF or PDF_TEMPLATE_PACK_TOKEN, or unset\n' +
      '          PDF_TEMPLATE_PACK_REPO to build with the built-in template only.'
  );
}

if (!existsSync(ENTRY)) {
  die(`${redact(repo)} at ${ref} has no index.ts, the pack's entry point (see README.md).`);
}

// Catch an obviously broken entry here rather than in a webpack error.
const entry = readFileSync(ENTRY, 'utf8');
if (!/export\s+default\b/.test(entry)) {
  die('pdf-templates/index.ts has no default export; it must export a TemplatePack.');
}

say(`checked out ${redact(repo)} at ${ref} (${headSha(DIR)})`);
