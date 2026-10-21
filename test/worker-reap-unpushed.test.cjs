'use strict';

/**
 * AEON-2473: worker-w2443 was reaped with two committed, unpushed branches, and god found them only by looking.
 * The reap notice now names every branch in the worker's worktrees (<harnessHome>/worktrees/<workerId> and the
 * worktrees under it) whose tip is not on its upstream, or on no remote at all.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const procs = loadTs('src/main/workerProcesses.ts');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

function scan(root, id) {
  assert.equal(typeof procs.unpushedWorkerBranches, 'function', 'no unpushed-branch scan: a reap notice cannot name stranded branches');
  return procs.unpushedWorkerBranches(root, id);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2473-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', remote, repo]);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  const wt = path.join(root, 'worktrees');
  fs.mkdirSync(path.join(wt, 'worker-w1'), { recursive: true });
  return { repo, wt, commit: (dir, m) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m) };
}

test('a pushed branch is not reported; a commit ahead of upstream and a branch with no remote are', (t) => {
  const { repo, wt, commit } = fixture(t);
  const pushed = path.join(wt, 'worker-w1', 'pushed');
  git(repo, 'worktree', 'add', '-q', '-b', 'worker-w1-pushed', pushed, 'HEAD');
  commit(pushed, 'done'); git(pushed, 'push', '-q', '-u', 'origin', 'worker-w1-pushed');
  assert.deepEqual(scan(wt, 'worker-w1'), []);

  commit(pushed, 'after the push');
  const local = path.join(wt, 'worker-w1', 'local');
  git(repo, 'worktree', 'add', '-q', '-b', 'worker-w1-local', local, 'HEAD');
  commit(local, 'never pushed');
  const found = scan(wt, 'worker-w1');
  assert.deepEqual(found.map((b) => [b.branch, b.upstream]).sort(), [['worker-w1-local', null], ['worker-w1-pushed', 'origin/worker-w1-pushed']]);
  const text = procs.describeUnpushed(found);
  assert.match(text, /NOT pushed/);
  assert.match(text, /worker-w1-local at [0-9a-f]+ .* \(on no remote\)/);
  assert.match(text, /worker-w1-pushed at [0-9a-f]+ .* \(ahead of origin\/worker-w1-pushed\)/);
});

test('the worker directory itself is scanned when it is a worktree, and a detached commit on no remote counts', (t) => {
  const { repo, wt, commit } = fixture(t);
  const own = path.join(wt, 'worker-w2');
  git(repo, 'worktree', 'add', '-q', '--detach', own, 'HEAD');
  assert.deepEqual(scan(wt, 'worker-w2'), [], 'a detached HEAD already on the remote is fine');
  commit(own, 'detached work');
  assert.deepEqual(scan(wt, 'worker-w2').map((b) => b.branch), ['HEAD']);
});

test('no worktrees, or an unsafe id, reports nothing to push', (t) => {
  const { wt } = fixture(t);
  assert.deepEqual(scan(wt, 'worker-w1'), []);
  assert.deepEqual(scan(wt, 'worker-none'), []);
  assert.deepEqual(scan(wt, '../x'), []);
  assert.equal(procs.describeUnpushed([]), 'Every branch in its worktrees is on its remote.');
  assert.match(procs.describeUnpushed(null), /could not be read/);
});
