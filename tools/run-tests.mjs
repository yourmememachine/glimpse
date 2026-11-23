#!/usr/bin/env node
// Small test runner: `node --test` needs real file paths (empty or missing
// directories make it fail), so discover *.test.js files under the known
// test roots and pass the files explicitly. Roots that do not exist yet
// are skipped, which keeps `npm test` green while a part of the repo is
// still being built.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const roots = ['tests', 'backend/test', 'app/test'];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, out);
    else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs')) out.push(path);
  }
  return out;
}

const files = roots
  .map((r) => join(root, r))
  .filter((d) => existsSync(d))
  .flatMap((d) => collect(d))
  .sort();

if (files.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

console.log(`Running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${f.slice(root.length + 1)}`);

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
