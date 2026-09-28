import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
export function endpointFor(root: string): string {
  const canonical = realpathSync(root);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0,32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\vibe-room-${key}` : path.join(canonical, '.room', 'service.sock');
}
