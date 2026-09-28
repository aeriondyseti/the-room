import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './main.js';

const pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const mainJs = fileURLToPath(new URL('./main.js', import.meta.url));

test('run(--version) prints the package version', () => {
  const lines: string[] = [];
  assert.equal(run(['--version'], (s) => lines.push(s)), 0);
  assert.deepEqual(lines, [pkgVersion]);
});

test('run(unknown) fails with a hint', () => {
  const errs: string[] = [];
  assert.equal(run(['frobnicate'], () => {}, (s) => errs.push(s)), 2);
  assert.match(errs[0] ?? '', /room --help/);
});

test('integration: `node dist/cli/main.js --version` prints the version', () => {
  const out = execFileSync(process.execPath, [mainJs, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkgVersion);
});

test('integration: unknown command exits 2', () => {
  const r = spawnSync(process.execPath, [mainJs, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
