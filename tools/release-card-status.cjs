'use strict';
// AEON-2553: at a fork tag, list every AEON id the range's commits name with its hive card status, so the cards
// whose fixes the tag ships are closed at the tag. Also lists non-merge commits that name no card.
// Usage: node tools/release-card-status.cjs <from-ref> <to-ref> [--tasks <hive>/tasks.json]   (default $HIVE_ROOT/tasks.json)
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const at = args.indexOf('--tasks');
const tasksPath = at >= 0 ? args.splice(at, 2)[1] : (process.env.HIVE_ROOT ? path.join(process.env.HIVE_ROOT, 'tasks.json') : null);
const [from, to] = args;
if (!from || !to || !tasksPath) {
  console.error('usage: node tools/release-card-status.cjs <from-ref> <to-ref> [--tasks <hive>/tasks.json] (or set HIVE_ROOT)');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
const cards = new Map((Array.isArray(raw) ? raw : raw.tasks || raw.cards || []).map((c) => [c.id, c]));
const log = execFileSync('git', ['log', '--reverse', '--format=%h%x1f%P%x1f%s%x1f%b%x1e', `${from}..${to}`], { encoding: 'utf8' });
const ids = new Map(), unnamed = [];
for (const rec of log.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
  const [sha, parents, subject, body] = rec.split('\x1f');
  const found = [...new Set(`${subject}\n${body}`.match(/AEON-\d+/g) || [])];
  if (!found.length && parents.split(' ').length < 2) unnamed.push(`${sha} ${subject}`);
  for (const id of found) if (!ids.has(id)) ids.set(id, sha);
}
console.log(`release-card-status: ${from}..${to}: ${ids.size} card(s) named`);
for (const [id, sha] of [...ids].sort((a, b) => Number(a[0].slice(5)) - Number(b[0].slice(5)))) {
  const c = cards.get(id);
  console.log(`  ${id}  ${(c ? c.status : 'NO CARD').padEnd(8)}  ${sha}  ${c ? (c.title || '').slice(0, 80) : ''}`);
}
if (unnamed.length) {
  console.log(`release-card-status: ${unnamed.length} non-merge commit(s) name no card; check none is a card's fix:`);
  for (const u of unnamed) console.log(`  ${u}`);
}
