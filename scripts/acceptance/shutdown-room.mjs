// Stop a scratch fixture room's service: node scripts/acceptance/shutdown-room.mjs <root>
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('usage: shutdown-room.mjs <room root>');
const { RoomClient } = await import(pathToFileURL(resolve('dist/ipc/client.js')).href);
const client = await RoomClient.connect(root, { client: 'tui', autoStart: false });
try { console.log(await client.request('shutdown', { caller: { kind: 'human' } })); } finally { client.close(); }
