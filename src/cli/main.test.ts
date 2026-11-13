import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntryPoint, run } from './main.js';

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
  assert.match(errs[0] ?? '', /roundtable --help/);
});

test('integration: `node dist/cli/main.js --version` prints the version', () => {
  const out = execFileSync(process.execPath, [mainJs, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkgVersion);
});

test('isEntryPoint matches the module path and tolerates missing files', () => {
  assert.equal(isEntryPoint(mainJs, new URL('./main.js', import.meta.url).href), true);
  assert.equal(isEntryPoint(undefined, import.meta.url), false);
  assert.equal(isEntryPoint(mainJs, import.meta.url), false);
  const ghost = mainJs + '.deleted.js';
  assert.equal(isEntryPoint(ghost, pathToFileURL(ghost).href), true, 'falls back to absolute paths, not a silent false');
});

test('integration: unknown command exits 2', () => {
  const r = spawnSync(process.execPath, [mainJs, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
