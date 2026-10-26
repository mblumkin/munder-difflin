'use strict';

/**
 * AEON-2553: tools/release-card-status.cjs lists, for a tag range, every AEON id its commits name with the hive card
 * status, so god closes those cards at the tag; and the non-merge commits that name none, so a fix like 61497a29f
 * (the unnamed AEON-2501 fix) is seen there instead of after nine cards stay open.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.resolve(__dirname, '..', 'tools', 'release-card-status.cjs');

test('a tag range lists each named card with its status, and the commits that name none', (t) => {
  assert.ok(fs.existsSync(TOOL), 'no tools/release-card-status.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2553r-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8' });
  let n = 0;
  const commit = (m) => { fs.writeFileSync(path.join(dir, `f${n++}`), 'x'); git('add', '-A'); git('commit', '-q', '-m', m); };
  git('init', '-q', '-b', 'main');
  commit('AEON-10: before the range'); git('tag', 'v1');
  commit('AEON-11: shipped and open');
  commit('processSnapshot reads a process table past 1 MB');
  git('checkout', '-q', '-b', 'side'); commit('worker grace\n\nAEON-12 in the body'); git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '--no-edit', 'side');
  commit('AEON-99: no card for this id'); git('tag', 'v2');
  const tasks = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify({ tasks: [{ id: 'AEON-10', status: 'todo' }, { id: 'AEON-11', status: 'todo', title: 'eleven' }, { id: 'AEON-12', status: 'done' }] }));
  const out = spawnSync(process.execPath, [TOOL, 'v1', 'v2', '--tasks', tasks], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout;
  assert.match(lines, /3 card\(s\) named/);
  assert.match(lines, /AEON-11\s+todo\s+\w+\s+eleven/);
  assert.match(lines, /AEON-12\s+done/);
  assert.match(lines, /AEON-99\s+NO CARD/);
  assert.doesNotMatch(lines, /AEON-10\b/, 'a commit before the range was listed');
  assert.match(lines, /1 non-merge commit\(s\) name no card[^\n]*\n\s+\w+ processSnapshot reads/);
  assert.doesNotMatch(lines, /Merge branch/, 'a merge commit was listed as naming no card');
});
