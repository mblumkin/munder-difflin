'use strict';
// AEON-3813: every hive git call ran under an 8 s timeout with
// gc.autoDetach=false, so a commit's inline `gc --auto` and the every-500-commits
// maintenance gc were killed partway on a large hive (two 199 MiB tmp_pack files).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// A git stand-in: logs every argv; a `gc` ignores SIGTERM, takes GC_DELAY_MS,
// and records that it finished. Everything else passes through to real git.
function fakeGit(dir) {
  const script = path.join(dir, 'fake-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AEON3813_LOG, JSON.stringify(args) + '\\n');
if (args.includes('gc')) {
  process.on('SIGTERM', () => {});
  setTimeout(() => { fs.appendFileSync(process.env.AEON3813_LOG, '"gc-finished"\\n'); process.exit(0); }, Number(process.env.GC_DELAY_MS));
  return;
}
const r = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });
process.exit(r.status ?? 1);
`, 'utf8');
  fs.chmodSync(script, 0o755);
  return script;
}

test('a commit never starts inline gc, and the maintenance gc outlives the per-call git timeout', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-3813-'));
  const log = path.join(home, 'git-calls.log');
  process.env.AEON3813_LOG = log;
  process.env.GC_DELAY_MS = '1200';
  const hive = new HiveManager(() => home, undefined, { everyCommits: 2 });
  t.after(async () => {
    await hive.flushGit();
    delete process.env.AEON3813_LOG; delete process.env.GC_DELAY_MS;
    fs.rmSync(home, { recursive: true, force: true });
  });
  hive.gitBin = fakeGit(home);
  hive.gitTimeoutMs = 300;     // stands in for the 8 s per-call cap
  hive.gitKillGraceMs = 100;

  hive.ensureHive();
  await hive.flushGit();
  hive.writeTasks([{ id: 'AEON-9813', title: 't', status: 'todo', dependsOn: [], priority: 0, createdAt: new Date().toISOString() }]);
  await hive.flushGit();

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const commits = calls.filter((a) => Array.isArray(a) && a.includes('commit'));
  assert.ok(commits.length >= 2, 'the init and task commits ran');
  for (const a of commits) {
    const cfg = a.filter((x, i) => a[i - 1] === '-c');
    assert.ok(cfg.includes('gc.auto=0'), `commit runs with gc.auto=0: ${a.join(' ')}`);
    assert.ok(cfg.includes('maintenance.auto=false'), `commit runs with maintenance.auto=false: ${a.join(' ')}`);
  }
  assert.ok(calls.some((a) => Array.isArray(a) && a.includes('gc')), 'the maintenance gc ran');
  assert.ok(calls.includes('gc-finished'), 'the maintenance gc was not killed by the per-call git timeout');
  // A pass-through call may still hit the shortened cap on a loaded box; only the gc's must not.
  assert.deepEqual(hive.logTail(500).filter((e) => e.kind === 'git-timeout' && /git gc\b/.test(e.message)), [], 'no gc timeout logged');
});
