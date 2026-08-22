// Reads .env the way Next does for this project's files, for the build-time
// scripts that run BEFORE next build and so never see Next's own loader.
//
// Precedence matches Next's: a real environment variable always wins, then
// .env.local, then .env. (Next would also read .env.development /
// .env.production — this project never uses them.)
//
// The parser is deliberate rather than a dotenv dependency: these scripts have
// to run under bare Node in the Vercel build, and the app itself ships no
// dotenv, so adding one purely for them would be its only reason to exist in
// the lockfile.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Fills in keys that are not already set, so a real env var beats the file. */
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

/** Loads .env.local then .env from the repo root into process.env. */
export function loadDotEnv(root) {
  loadEnvFile(path.join(root, '.env.local'));
  loadEnvFile(path.join(root, '.env'));
}
