'use strict';

/**
 * AEON-3757: a respawn of a worker id whose agent/<id> branch survived (a timed-out or failed add, or a kept tree)
 * fell back to `worktree add <path> <base>`, which git refuses whenever <base> is checked out in another worktree
 * (the main checkout, always). The respawn must get a tree on agent/<id>: reset to base when the leftover holds
 * nothing base lacks, kept as is when it carries commits of its own.
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

function repoWithLeftover(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3757-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'agent/worker-x'); // the leftover of an earlier spawn of this id
  return { repo, wtPath: path.join(home, 'worktrees', 'worker-x') };
}

test('a respawn with a merged leftover branch gets a tree on agent/<id> at base while base is checked out', async (t) => {
  const { repo, wtPath } = repoWithLeftover(t);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'base moved on');

  const res = await addWorktree(repo, wtPath, 'main');

  assert.equal(res.ok, true, `addWorktree failed: ${res.error}`);
  assert.equal(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/worker-x');
  assert.equal(git(wtPath, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
});

test('a respawn with a leftover branch carrying its own commits reuses it without losing them', async (t) => {
  const { repo, wtPath } = repoWithLeftover(t);
  git(repo, 'checkout', '-q', 'agent/worker-x');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'work\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'unintegrated work');
  const work = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');

  const res = await addWorktree(repo, wtPath, 'main');

  assert.equal(res.ok, true, `addWorktree failed: ${res.error}`);
  assert.equal(git(wtPath, 'rev-parse', 'HEAD'), work);
});
