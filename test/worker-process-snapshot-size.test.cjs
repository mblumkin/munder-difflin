'use strict';

/**
 * A busy host's full process table outgrew spawnSync's default 1 MB buffer (1,076,714 bytes measured on 2026-10-21:
 * agents' tool commands run to 12 KB each). processSnapshot then failed ENOBUFS and returned null, so every idle reap
 * deferred as "process ancestry unavailable" and kill(id, true) refused to stop a worker. A fake `ps` first on PATH
 * prints a 2 MB table and the snapshot must still parse it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

test('a process table past 1 MB still snapshots', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX ps only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-buffer-'));
  const rows = path.join(dir, 'rows.txt');
  const long = 'x'.repeat(10_000);
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`${1000 + i} 1 Tue Oct 21 01:20:00 2026 /bin/zsh -c ${long}`);
  lines.push('9999 1000 Tue Oct 21 01:20:00 2026 bash /hive/bin/browser-run.sh --wait-for-lock=60 -- node x.mjs');
  fs.writeFileSync(rows, lines.join('\n') + '\n');
  assert.ok(fs.statSync(rows).size > 2 * 1024 * 1024 - 100_000, 'fixture is past the default buffer');
  fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\ncat ${JSON.stringify(rows)}\n`);
  fs.chmodSync(path.join(dir, 'ps'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  const { processSnapshot, descendantsOf, isQueueWait } = loadTs('src/main/workerProcesses.ts');
  const snap = processSnapshot();
  assert.ok(snap, 'snapshot is null: ps output past 1 MB failed ENOBUFS');
  assert.equal(snap.length, 201);
  assert.equal(isQueueWait(descendantsOf(snap, 1000)), true, 'the waiter under pid 1000 is found');
});
