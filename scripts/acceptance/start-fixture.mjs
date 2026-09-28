// Start ONE throwaway Claude fixture in its own scratch room and leave it running (for handoffs, e.g. 4.2 checks).
// Usage: node scripts/acceptance/start-fixture.mjs <name starting with fx> [label]
// Stop later with: claude stop <shortId> && claude rm <shortId>, then shutdown-room.mjs <root>.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRoot, start } from './claude-fixture.mjs';

const name = process.argv[2] ?? 'fxh';
const root = makeRoot(process.argv[3] ?? 'handoff');
const { RoomClient } = await import(pathToFileURL(resolve('dist/ipc/client.js')).href);
const client = await RoomClient.connect(root, { client: 'tui' });
try {
  const whoIs = async (n, sid) => (await client.request('who', {})).participants.some((p) => p.name === n && p.sessionId === sid);
  const fx = await start({ name, root, dist: resolve('dist/cli/main.js'), whoIs });
  console.log(JSON.stringify({ name: fx.name, harness: 'claude', sessionId: fx.sessionId, pid: fx.pid, shortId: fx.shortId, display: fx.display, roomRoot: root }, null, 1));
} finally {
  client.close();
}
