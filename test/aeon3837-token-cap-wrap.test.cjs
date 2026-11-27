'use strict';
// AEON-3837 (scope v2): no worker is reaped at its token cap with unsaved work.
// 11-27: worker-w38-hivetools hit its 20M cap and was killed with four patches
// existing only as uncommitted clone diffs. Notices at 70% and 90%; at the cap a
// WRAP grace; a reap as soon as the wrap check passes; on grace exhaustion the
// dirty tree and the unpushed tip are saved to refs/wip/<id>/<stamp>/ first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { capTick, wrapCheck, autosaveWip, sentHandoffInform, capReapDetail, WRAP_GRACE_MS } = loadTs('src/main/workerWrap.ts');

const id = 'worker-w9837';
const cap = 10_000_000;
const t0 = Date.parse('2026-11-27T04:00:00Z');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A worker's world: a hive root, a bare remote, and a worktree clone on its own branch. */
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-3837-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const wt = path.join(dir, 'wt');
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(path.join(hive, 'agents', id, 'outbox', '.sent'), { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'base\n');
  git(wt, 'add', 'a.txt');
  git(wt, 'commit', '-q', '-m', 'base');
  git(wt, 'push', '-q', 'origin', 'HEAD:main');
  git(wt, 'checkout', '-q', '-b', `agent/${id}`);
  const calls = { notices: [], reaps: [] };
  const deps = {
    notify: (n) => calls.notices.push(n.subject),
    check: () => wrapCheck(wt, 'main', () => sentHandoffInform(hive, id, t0)),
    autosave: () => autosaveWip(wt, 'main', id, t0 + WRAP_GRACE_MS),
    reap: (why, refs) => calls.reaps.push({ why, refs, detail: capReapDetail(why, refs, wt) })
  };
  const state = { sent: [] };
  const tick = async (used, now) => { const p = capTick(state, used, cap, now, deps); if (p) await p; };
  return { wt, hive, remote, calls, tick, state };
}

test('(i) the 70% and 90% notices each arrive exactly once', async (t) => {
  const w = world(t);
  for (const used of [1e6, 6.9e6, 7e6, 7.2e6, 8.9e6, 9e6, 9.5e6, 10e6]) await w.tick(used, t0);
  assert.deepEqual(w.calls.notices, ['Token cap 70%: wrap as you go', 'Token cap 90%: wrap as you go']);
  assert.deepEqual(w.calls.reaps, [], 'at exactly the cap nothing is reaped');
});

test('(ii) past the cap there is no kill while the wrap check fails and grace remains', async (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'unsaved work\n');
  await w.tick(10.1e6, t0);
  await w.tick(10.5e6, t0 + 5 * 60_000);
  await w.tick(11.0e6, t0 + WRAP_GRACE_MS - 1000);   // just under both the token and the time grace
  assert.deepEqual(w.calls.reaps, []);
  assert.equal(w.calls.notices.filter((s) => s === 'Token cap reached: wrap now').length, 1, 'one wrap notice');
});

test('(iii) a worker in WRAP is reaped as soon as the wrap check passes', async (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'finished\n');
  await w.tick(10.1e6, t0);
  git(w.wt, 'commit', '-q', '-am', 'finish');
  await w.tick(10.2e6, t0 + 60_000);
  assert.deepEqual(w.calls.reaps, [], 'committed but unpushed and no HANDOFF inform: not wrapped');
  git(w.wt, 'push', '-q', 'origin', `agent/${id}`);
  await w.tick(10.3e6, t0 + 120_000);
  assert.deepEqual(w.calls.reaps, [], 'pushed but no done or HANDOFF inform: not wrapped');
  fs.writeFileSync(path.join(w.hive, 'agents', id, 'outbox', '.sent', 'm.json'),
    JSON.stringify({ from: id, to: 'god', act: 'inform', subject: 'wrapped', body: 'see wip/HANDOFF.md', created_at: new Date(t0 + 130_000).toISOString() }));
  await w.tick(10.4e6, t0 + 180_000);
  assert.deepEqual(w.calls.reaps.map((r) => [r.why, r.refs]), [['wrapped', []]]);
  await w.tick(10.5e6, t0 + 240_000);
  assert.equal(w.calls.reaps.length, 1, 'reaped once');
});

test('(iv) on grace exhaustion refs/wip holds the dirty content and the unpushed tip, and the reap notice names them', async (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'committed, never pushed\n');
  git(w.wt, 'commit', '-q', '-am', 'local only');
  const tip = git(w.wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'dirty, never committed\n');
  await w.tick(10.1e6, t0);
  await w.tick(11.2e6, t0 + 60_000);   // past the 1,000,000-token grace
  assert.equal(w.calls.reaps.length, 1);
  const [{ why, refs, detail }] = w.calls.reaps;
  assert.equal(why, 'grace-exhausted');
  const treeRef = refs.find((r) => r.endsWith('/tree'));
  const tipRef = refs.find((r) => r.endsWith('/tip'));
  assert.match(treeRef, new RegExp(`^refs/wip/${id}/[0-9TZ-]+/tree$`));
  assert.equal(git(w.wt, 'show', `${treeRef}:a.txt`), 'dirty, never committed');
  assert.equal(git(w.wt, 'rev-parse', tipRef), tip);
  assert.equal(fs.readFileSync(path.join(w.wt, 'a.txt'), 'utf8'), 'dirty, never committed\n', 'the worktree is untouched');
  assert.equal(git(w.wt, 'stash', 'list'), '', 'the stash list is untouched');
  assert.equal(execFileSync('git', ['ls-remote', w.remote], { encoding: 'utf8' }).includes('refs/wip/'), false, 'never pushed');
  for (const r of refs) assert.ok(detail.includes(r), `the reap notice names ${r}`);
});
