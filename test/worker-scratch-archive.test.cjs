'use strict';

/**
 * AEON-2507: releasing an ephemeral worker deleted hive/agents/<worker>/, untracked wip included. At 06:06Z
 * worker-w2492 reported its AEON-2496 patch at agents/worker-w2492/aeon2496.patch and sent act:done; by 06:26Z the
 * folder was gone and god recovered the change from a /tmp clone by luck. The folder is now moved to
 * <hive>/archived-agents/<id>-<time>/ and the move is named in god's notice.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

function archive(root, id, now) {
  const mod = loadTs('src/main/workerScratch.ts');
  assert.equal(typeof mod.archiveWorkerScratchIfSafe, 'function', 'no archive: a released worker folder is deleted');
  return mod.archiveWorkerScratchIfSafe(root, id, now);
}

function hive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2507-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const dir = path.join(root, 'agents', 'worker-w2492');
  for (const d of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'aeon2496.patch'), 'diff --git a/x b/x\n');
  fs.writeFileSync(path.join(dir, 'outbox', '.sent', 'done.json'), '{"act":"done"}');
  return { root, dir };
}

test('a released worker folder with an undelivered patch is moved, not deleted', (t) => {
  const { root, dir } = hive(t);
  const out = archive(root, 'worker-w2492', Date.parse('2026-10-21T06:26:00Z'));
  assert.equal(out.result, 'archived');
  assert.equal(fs.existsSync(dir), false, 'the live agents/ entry is gone, so no script reads it as an agent');
  assert.equal(path.dirname(out.to), path.join(root, 'archived-agents'));
  assert.match(path.basename(out.to), /^worker-w2492-2026-10-21T06-26-00-000Z$/);
  assert.equal(fs.readFileSync(path.join(out.to, 'aeon2496.patch'), 'utf8'), 'diff --git a/x b/x\n', 'the delivered patch survives');
  assert.ok(fs.existsSync(path.join(out.to, 'outbox', '.sent', 'done.json')));
});

test('the archive never reaches the hive git, and a second archive at the same time does not collide', (t) => {
  const { root } = hive(t);
  const at = Date.parse('2026-10-21T06:26:00Z');
  const first = archive(root, 'worker-w2492', at);
  fs.mkdirSync(path.join(root, 'agents', 'worker-w2492'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'worker-w2492', 'again.txt'), 'second hire\n');
  const second = archive(root, 'worker-w2492', at);
  assert.equal(second.result, 'archived');
  assert.notEqual(second.to, first.to);
  assert.ok(fs.existsSync(path.join(first.to, 'aeon2496.patch')) && fs.existsSync(path.join(second.to, 'again.txt')));
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(status, /archived-agents/, `archive shows up in git status:\n${status}`);
});

test('a folder with tracked evidence stays where it is, and an unsafe id is refused', (t) => {
  const { root, dir } = hive(t);
  spawnSync('git', ['-C', root, 'add', path.join(dir, 'aeon2496.patch')]);
  assert.equal(archive(root, 'worker-w2492').result, 'tracked');
  assert.ok(fs.existsSync(path.join(dir, 'aeon2496.patch')));
  assert.equal(archive(root, '../worker-x').result, 'unknown');
  assert.equal(archive(root, 'god').result, 'unknown');
});
