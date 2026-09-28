#!/usr/bin/env node
// Kevin's sender. Usage: node poc/say.mjs [@astra|@claude|@all] message...
// Default recipient is all agents. Reads the message from stdin if none is given on the command line.
import { send } from './lib.mjs';

let args = process.argv.slice(2);
const targets = [];
while (args[0]?.startsWith('@')) targets.push(args.shift().slice(1));
let text = args.join(' ');
if (!text) text = await new Promise(r => { let s = ''; process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => r(s.trim())); });

const result = await send({ from: 'kevin', to: targets.length ? targets : 'all', text });
for (const [name, d] of Object.entries(result.deliveries)) {
  console.log(`${result.id} -> ${name}: ${d.ok ? 'sent' : 'FAILED'} (${d.evidence ?? d.error}${d.native_id ? ' ' + d.native_id : ''})`);
}
