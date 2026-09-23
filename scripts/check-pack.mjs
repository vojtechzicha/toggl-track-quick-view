#!/usr/bin/env node
// Runs the template pack's own checks, if a pack is checked out
// (`pnpm check:pack`).
//
// Each `pdf-templates/checks/*.ts` runs in its own process, so a check that
// stubs a module (e.g. pdfmake) can't affect the next. With no pack, or no
// checks, it prints a line and passes.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKS = path.join(root, 'pdf-templates', 'checks');

if (!existsSync(path.join(root, 'pdf-templates', 'index.ts'))) {
  console.log('✓ no template pack checked out; nothing to check.');
  process.exit(0);
}

const files = existsSync(CHECKS)
  ? readdirSync(CHECKS)
      .filter((f) => f.endsWith('.ts'))
      .sort()
  : [];

if (files.length === 0) {
  console.log('✓ the template pack has no checks.');
  process.exit(0);
}

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(CHECKS, file)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`✗ pdf-templates/checks/${file} failed`);
    process.exit(result.status ?? 1);
  }
}
