import { readFileSync } from 'node:fs';

/** The package version, single-sourced from package.json (ADR-0003). */
export const VERSION: string = (() => {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
  if (typeof version !== 'string') throw new Error('package.json has no version');
  return version;
})();
