'use strict';

/**
 * AEON-3682: addWorktree ran `git worktree add` under runGit's 8 s default timeout. On the hive (30k+ tracked files)
 * the checkout outlives 8 s, git is SIGKILLed before it removes `.git/worktrees/<id>/locked`, the seat falls back to the
 * shared cwd and the tree keeps "locked initializing" forever. A smudge filter that sleeps past 8 s stands in for the
 * big checkout: the add must finish, and the new tree must carry no lock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { addWorktree } = loadTs('src/main/git.ts');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('a worktree add that outlives 8 s completes and leaves no initializing lock', { timeout: 60_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3682-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'filter.slow.smudge', 'sleep 10; cat');
  git(repo, 'config', 'filter.slow.clean', 'cat');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'big.txt filter=slow\n');
  fs.writeFileSync(path.join(repo, 'big.txt'), 'payload\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');

  const wtPath = path.join(home, 'worktrees', 'worker-slow');
  const res = await addWorktree(repo, wtPath, 'main');

  assert.equal(res.ok, true, `addWorktree failed: ${res.error}`);
  assert.equal(fs.readFileSync(path.join(wtPath, 'big.txt'), 'utf8'), 'payload\n');
  const list = git(repo, 'worktree', 'list', '--porcelain');
  assert.doesNotMatch(list, /^locked/m, `a lock survived the add:\n${list}`);
});

test('an add killed by its timeout is cleaned up, not left locked', { timeout: 60_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3682-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'filter.slow.smudge', 'sleep 3; cat');
  git(repo, 'config', 'filter.slow.clean', 'cat');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'big.txt filter=slow\n');
  fs.writeFileSync(path.join(repo, 'big.txt'), 'payload\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');

  const wtPath = path.join(home, 'worktrees', 'worker-killed');
  const res = await addWorktree(repo, wtPath, 'main', 500);

  assert.equal(res.ok, false);
  assert.match(res.error, /killed after 500 ms/);
  await new Promise((r) => setTimeout(r, 3500)); // let the orphaned checkout child finish writing
  const list = git(repo, 'worktree', 'list', '--porcelain');
  assert.doesNotMatch(list, /^locked/m, `the killed add left a lock:\n${list}`);
  assert.doesNotMatch(list, /worker-killed/, `the killed add left its tree registered:\n${list}`);
});
