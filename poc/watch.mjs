#!/usr/bin/env node
// Live view of the pair room. Usage: node poc/watch.mjs [--history N]
import fs from 'node:fs';
import { LOG } from './lib.mjs';

const hIndex = process.argv.indexOf('--history');
const history = hIndex > 0 ? Number(process.argv[hIndex + 1]) : 30;
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const who = { kevin: 33, claude: 35, astra: 36 };

function render(r) {
  const t = r.ts.slice(11, 19);
  if (r.type === 'message') {
    const head = `${t} ${color(who[r.from] ?? 37, r.from)} -> ${r.to.join(', ')}${r.reply_to ? color(90, ` (re ${r.reply_to})`) : ''} ${color(90, r.id)}`;
    console.log(`\n${head}\n${r.text.split('\n').map(l => '  ' + l).join('\n')}`);
  } else if (r.type === 'delivery') {
    console.log(color(r.ok ? 90 : 31, `  ${r.ok ? '✓' : '✗'} ${r.to}: ${r.ok ? r.evidence : r.error}`));
  }
}

let offset = 0;
let partial = '';
function pump(initial) {
  if (!fs.existsSync(LOG)) return;
  const size = fs.statSync(LOG).size;
  if (size < offset) offset = 0;
  if (size === offset) return;
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (partial + buf.toString('utf8')).split('\n');
  partial = lines.pop();
  let records = lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (initial) {
    const firstShown = records.filter(r => r.type === 'message').slice(-history)[0];
    records = firstShown ? records.slice(records.indexOf(firstShown)) : [];
  }
  records.forEach(render);
}

console.log(color(90, `watching ${LOG} (Ctrl+C to exit; send with: node poc/say.mjs [@name] message)`));
pump(true);
setInterval(() => pump(false), 700);
