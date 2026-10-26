'use strict';

/**
 * AEON-2553: fork commit 61497a29f (the AEON-2501 fix) named no card, so a card-id sweep missed a shipped fix and
 * nine cards stayed open after their tags. tools/git-hooks/commit-msg refuses a commit that names no AEON id; a
 * merge needs none, and MD_COMMIT_NO_CARD records why a commit serves no card. Driven through real git commits
 * with core.hooksPath at this tree's hooks; tools/install-git-hooks.cjs sets that path and keeps a deliberate one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'tools', 'git-hooks');

function repo(t, hooks = HOOKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2553-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, env = {}) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MD_COMMIT_NO_CARD: '', ...env } });
  assert.equal(git(['init', '-q', '-b', 'main']).status, 0);
  if (hooks) assert.equal(git(['config', 'core.hooksPath', hooks]).status, 0);
  let n = 0;
  const commit = (message, env) => { fs.writeFileSync(path.join(dir, `f${n++}.txt`), 'x\n'); git(['add', '-A']); return git(['commit', '-q', '-m', message], env); };
  return { dir, git, commit };
}

test('the fork carries a commit-msg hook', () => {
  assert.ok(fs.existsSync(path.join(HOOKS, 'commit-msg')), 'no tools/git-hooks/commit-msg: a commit can name no card');
});

test('a commit that names no AEON card is refused, naming the fix', (t) => {
  const r = repo(t);
  assert.equal(r.commit('AEON-1: base').status, 0);
  const out = r.commit('processSnapshot reads a process table past 1 MB');
  assert.notEqual(out.status, 0, 'the 61497a29f message was accepted');
  assert.match(out.stderr, /names no AEON card/);
  assert.equal(r.git(['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.notEqual(r.commit('fix it\n\n# AEON-2 in a comment line is dropped by git').status, 0, 'an id only in a # line counted');
});

test('a commit naming its card, a merge, and a reasoned no-card commit go through', (t) => {
  const r = repo(t);
  assert.equal(r.commit('AEON-2553: base').status, 0);
  assert.equal(r.commit('worker reaper: keep a busy worker\n\nFixes AEON-2473.').status, 0, 'an id in the body counts');
  r.git(['checkout', '-q', '-b', 'side']);
  assert.equal(r.commit('AEON-3: side').status, 0);
  r.git(['checkout', '-q', 'main']);
  assert.equal(r.commit('AEON-4: main').status, 0);
  const merge = r.git(['merge', '--no-ff', '--no-edit', 'side']);
  assert.equal(merge.status, 0, `a merge with git's own message was refused: ${merge.stderr}`);
  assert.match(r.git(['log', '-1', '--format=%s']).stdout, /^Merge branch 'side'/);
  assert.equal(r.commit('Bump version to 0.5.22', { MD_COMMIT_NO_CARD: 'release cut' }).status, 0);
  assert.match(r.git(['log', '-1', '--format=%B']).stdout, /No-Card: release cut/, 'the escape left no trace');
});

test('the installer sets the tracked hooks path, and keeps one set on purpose', (t) => {
  const r = repo(t, null);
  fs.mkdirSync(path.join(r.dir, 'tools', 'git-hooks'), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, 'commit-msg'), path.join(r.dir, 'tools', 'git-hooks', 'commit-msg'));
  const install = () => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'install-git-hooks.cjs')], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(install().status, 0);
  assert.equal(r.git(['config', '--get', 'core.hooksPath']).stdout.trim(), 'tools/git-hooks');
  assert.notEqual(r.commit('no card').status, 0, 'the installed hook did not run');
  r.git(['config', 'core.hooksPath', '/elsewhere']);
  assert.equal(install().status, 0);
  assert.equal(r.git(['config', '--get', 'core.hooksPath']).stdout.trim(), '/elsewhere');
});
