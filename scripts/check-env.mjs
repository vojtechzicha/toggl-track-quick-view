#!/usr/bin/env node
// Validates the environment against scripts/env-spec.mjs. Runs first in
// `vercel-build`, so a variable missing in Vercel fails the PR's preview
// build. Locally: `pnpm env:check`. Paths resolve from the repo root.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_SPEC, EXTERNAL_ENV, present, validateEnv } from './env-spec.mjs';
import { loadDotEnv } from './load-env.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

loadDotEnv(root);

// The Vercel CLI (`vercel link`, `vercel env pull`) creates .env.local, and
// Next loads it ahead of .env.
if (existsSync(path.join(root, '.env.local'))) {
  console.warn(
    '  note     .env.local exists and overrides .env, including after `pnpm env:pull`. The Vercel CLI creates it; delete it unless you need it.'
  );
}

// .env.tpl leaves APP_PASSWORD blank, so explain an unexpected password prompt.
function localGateNote() {
  if (!present(process.env, 'APP_PASSWORD')) return null;
  if (!present(process.env, 'TOGGL_API_TOKEN') && !present(process.env, 'MONGODB_URI')) return null;
  return 'the password gate is on: APP_PASSWORD is set in your .env (.env.tpl leaves it blank)';
}

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
