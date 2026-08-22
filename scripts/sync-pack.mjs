#!/usr/bin/env node
// Checks out the optional PDF template pack into pdf-templates/.
//
// Runs before `next dev` and `next build` (see package.json). With no pack
// configured it prints one line and exits 0 — that is the supported default,
// and what a plain clone of this repository does: the app then offers its own
// Timesheet template alone (lib/export/pdf/emptyPack.ts).
//
// What gets COMPILED IN is decided by the directory, not by the variable: the
// `@pdf-template-pack` alias resolves against pdf-templates/ existing. The
// variable decides only what is FETCHED into it. So clearing the variable stops
// the updates but keeps whatever is on disk — this script never deletes a
// checkout, because it cannot tell one it made from one cloned by hand, and
// silently discarding someone's working tree is not a thing a prebuild step
// should do. Removing a pack is `rm -rf pdf-templates`, and the line printed
// below says so.
//
// Why a checkout rather than a git submodule: a submodule puts the pack's URL
// in .gitmodules, and every clone — every FORK — then tries to fetch it. A
// private pack would fail that fetch and take the fork's build down with it,
// for a repository that has no business knowing the pack exists. Naming the
// pack in the ENVIRONMENT keeps it a property of the deployment, which is what
// it is.
//
// It is deliberately loud in one direction only: a pack that is configured but
// cannot be fetched FAILS the build. Continuing would produce a green
// deployment whose export dialog had quietly lost every template the documents
// are actually filed under — the same failure shape APP_MODE guards against
// (see scripts/env-spec.mjs).

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
 * The URL git is actually given. A token turns an https remote into an
 * authenticated one; ssh remotes carry their own credentials and are left
 * alone. Never logged — `redact()` is what goes on screen.
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
    // A prompt would hang a CI build forever waiting for a password nobody
    // will type.
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
 * Whether a failed fetch is the machine's fault rather than the configuration's.
 * A laptop on a train should still start its dev server against the checkout it
 * already has; a ref that does not exist, or a token that is not allowed to
 * read the repository, will not fix itself and must not be papered over.
 */
const isNetworkError = (detail) =>
  /could not resolve host|couldn't resolve host|connection (refused|reset|closed|timed out)|operation timed out|network is unreachable|no route to host|failed to connect|temporary failure in name resolution|kex_exchange|timed out/i.test(
    detail
  );

// ---- no pack configured: the default ----

if (!repo) {
  if (existsSync(ENTRY)) {
    say('PDF_TEMPLATE_PACK_REPO is not set, so nothing was fetched — but pdf-templates/');
    say(`is on disk (${headSha(DIR)}) and IS compiled in. Delete it to build without a pack.`);
  } else {
    say('no template pack configured — exports offer this app\'s own Timesheet template.');
  }
  process.exit(0);
}

// ---- a checkout that is not ours: leave it alone ----

if (existsSync(DIR) && !existsSync(path.join(DIR, '.git'))) {
  if (!existsSync(ENTRY)) {
    die(
      `pdf-templates/ exists but is neither a git checkout nor a template pack (no index.ts). ` +
        'Remove it, or point PDF_TEMPLATE_PACK_REPO at nothing and manage it by hand.'
    );
  }
  say('pdf-templates/ is a hand-managed checkout (no .git) — left untouched.');
  process.exit(0);
}

// ---- update or clone ----

const existing = existsSync(path.join(DIR, '.git'));

try {
  // `init` + `fetch <ref>` rather than `clone --branch`: one network round
  // trip, and `ref` may equally be a branch, a tag or a pinned commit.
  if (!existing) {
    mkdirSync(DIR, { recursive: true });
    git(['init', '--quiet', DIR]);
  }
  fetchInto(DIR, repo);
} catch (err) {
  const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' ');
  if (existing && existsSync(ENTRY) && isNetworkError(detail)) {
    // Offline on a laptop is not a reason to refuse to start; the checkout on
    // disk is still a pack. Anything else — a ref that does not exist, a token
    // that cannot read the repository — falls through to die(), because it is
    // configuration and will still be wrong on the next build.
    say(`could not reach ${redact(repo)} (${detail})`);
    say(`keeping the checkout already on disk (${headSha(DIR)}) — it may not be ${ref}.`);
    process.exit(0);
  }
  if (!existing) rmSync(DIR, { recursive: true, force: true });
  die(
    `could not check out ${redact(repo)} at ${ref}: ${detail}\n` +
      '          PDF_TEMPLATE_PACK_REPO is set, so the templates it carries are part of this\n' +
      '          deployment; building without them would ship an export dialog that has\n' +
      '          silently lost them. Fix the URL, the ref or PDF_TEMPLATE_PACK_TOKEN, or\n' +
      '          unset PDF_TEMPLATE_PACK_REPO to build with this app\'s own templates.'
  );
}

if (!existsSync(ENTRY)) {
  die(`${redact(repo)} at ${ref} has no index.ts — a template pack's entry point (see README.md).`);
}

// A pack is source that gets compiled into the app; a broken one should say so
// here rather than 200 lines into a webpack error.
const entry = readFileSync(ENTRY, 'utf8');
if (!/export\s+default\b/.test(entry)) {
  die('pdf-templates/index.ts has no default export — a pack\'s entry point exports a TemplatePack.');
}

say(`checked out ${redact(repo)} at ${ref} (${headSha(DIR)})`);
