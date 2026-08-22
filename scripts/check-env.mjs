#!/usr/bin/env node
// Validates the deployment configuration against scripts/env-spec.mjs.
//
// Runs in the Vercel build (see the "vercel-build" script) so a variable that
// was added in code but never set in the Vercel project fails the build — and
// fails the pull request's own preview deployment first, which is where you
// want to find out. Locally: `pnpm env:check`.
//
// Reads the environment the way Next does for this project's files: real env
// vars win, then .env.local, then .env. (Next would also read
// .env.development / .env.production — this project never uses them.) Paths
// resolve against the repo root, not the CWD, so the check works from anywhere.
//
// The .env parser below is deliberate rather than a dotenv dependency: this
// file has to run under bare Node before `next build`, and the app itself ships
// no dotenv, so adding one purely for a build-time check would be the only
// reason it exists in the lockfile.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_SPEC, EXTERNAL_ENV, present, validateEnv } from './env-spec.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Fills in keys that are not already set, so a real environment variable always
 * beats the file — the same precedence Next applies.
 */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // blank line, comment, or continuation of a quoted value
    const [, key] = match;
    let value = match[2].trim();
    if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim(); // trailing comment on a bare value
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(root, '.env.local'));
loadEnvFile(path.join(root, '.env'));

// `vercel link` and `vercel env pull` write a .env.local holding a VERCEL_OIDC_
// TOKEN. Nothing in this app reads it, but Next loads .env.local ahead of .env,
// so anything else that ends up in that file silently outranks every
// `pnpm env:pull` from then on.
if (existsSync(path.join(root, '.env.local'))) {
  console.warn(
    '  note     .env.local exists and overrides the generated .env — values there survive every `pnpm env:pull`. Vercel CLI creates it; delete it unless you put something there on purpose.'
  );
}

// A password prompt on `pnpm dev` surprises people, because .env.tpl ships
// APP_PASSWORD blank — the gate is opt-in locally. Say where it came from.
// The value is never printed; the name and the source are enough.
function localGateNote() {
  if (!present(process.env, 'APP_PASSWORD')) return null;
  if (!present(process.env, 'TOGGL_API_TOKEN') && !present(process.env, 'MONGODB_URI')) return null;
  return 'the password gate is active — APP_PASSWORD is set in your .env, where .env.tpl leaves it blank';
}

// prod / preview / dev decides which specs are required and which combinations
// are worth complaining about.
const environment =
  process.env.VERCEL_ENV === 'production' ? 'prod' : process.env.VERCEL_ENV === 'preview' ? 'preview' : 'dev';

const { errors, warnings } = validateEnv(process.env, environment);

const configured = ENV_SPEC.filter((spec) => present(process.env, spec.name)).map((s) => s.name);
console.log(`Checked ${ENV_SPEC.length} variables (as ${environment}), ${configured.length} configured.`);

if (environment === 'dev') {
  const note = localGateNote();
  if (note) console.log(`  note     ${note}`);
}

for (const warning of warnings) console.warn(`  warning  ${warning}`);
for (const error of errors) console.error(`  ERROR    ${error}`);

if (errors.length) {
  console.error(
    `\n${errors.length} problem(s) in the environment.` +
      `\nLocal: add the variable to .env.tpl and run \`pnpm env:pull\`.` +
      `\nVercel: Settings > Environment Variables, then redeploy.` +
      `\nPlatform-provided variables (${EXTERNAL_ENV.platform.join(', ')}) are never set here.`
  );
  process.exit(1);
}

console.log(warnings.length ? 'Environment usable, with warnings above.' : 'Environment OK.');
