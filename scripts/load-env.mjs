// Loads .env files for scripts that run before `next build` and so miss Next's
// loader. Precedence matches Next: real environment variables, then
// .env.local, then .env. (.env.development / .env.production are not used in
// this project.) A small parser instead of dotenv, which the app does not
// otherwise depend on.

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
