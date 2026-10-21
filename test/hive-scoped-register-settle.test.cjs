'use strict';

/**
 * AEON-2495: `hive: register <id>` (every spawn) and `hive: settle inbox of <id>` committed with a bare
 * `git add -A`, which stages the whole shared hive. With 594 untracked files the router guard's unstage took 7.72 s
 * against gitTimeoutMs 8000, and the kill left 172-305 files staged. Both now stage only what they wrote, and a git
 * timeout is recorded in log.jsonl with the command.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout;

async function hiveWithStrays(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2495-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  await hive.flushGit();
  const root = path.join(home, 'hive');
  // Another seat's work in progress, which a commit about this agent must not sweep in.
  fs.writeFileSync(path.join(root, 'stray-root.txt'), 'not mine\n');
  fs.mkdirSync(path.join(root, 'agents', 'someone-else'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'someone-else', 'draft.md'), 'not mine either\n');
  return { hive, root };
}

const committed = (root) => git(root, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n').filter(Boolean);
const staged = (root) => git(root, 'diff', '--cached', '--name-only').trim();

test('registering an agent commits its own files and registry.json, not the rest of the hive', async (t) => {
  const { hive, root } = await hiveWithStrays(t);
  await hive.ensureAgent({ id: 'worker-a', name: 'A', cwd: os.tmpdir() });
  await hive.flushGit();
  const [subject, ...files] = committed(root);
  assert.equal(subject, 'hive: register worker-a');
  assert.ok(files.includes('registry.json'), files.join(', '));
  assert.ok(files.some((f) => f.startsWith('agents/worker-a/')), files.join(', '));
  assert.deepEqual(files.filter((f) => /stray-root|someone-else/.test(f)), [], `swept in other files: ${files.join(', ')}`);
  assert.equal(staged(root), '', 'nothing is left staged');
  assert.match(git(root, 'status', '--porcelain'), /\?\? stray-root\.txt/);
});

test('settling an inbox commits its log line, not the rest of the hive', async (t) => {
  const { hive, root } = await hiveWithStrays(t);
  await hive.ensureAgent({ id: 'worker-b', name: 'B', cwd: os.tmpdir() });
  await hive.flushGit();
  // Fresh strays after the register commit, so this test does not lean on the register scope.
  fs.writeFileSync(path.join(root, 'stray-later.txt'), 'not mine\n');
  fs.writeFileSync(path.join(root, 'agents', 'someone-else', 'later.md'), 'not mine either\n');
  const inbox = path.join(root, 'agents', 'worker-b', 'inbox');
  fs.writeFileSync(path.join(inbox, 'm1.json'), JSON.stringify({ id: 'm1', from: 'god', act: 'inform', subject: 's', created_at: '2026-10-21T04:00:00Z' }));
  const settled = hive.settleInbox('worker-b');
  assert.equal(settled.moved, 1);
  await hive.flushGit();
  const [subject, ...files] = committed(root);
  assert.match(subject, /^hive: settle inbox of worker-b/);
  // Inbox files are git-ignored per agent dir, so the settle is recorded by its log line alone.
  assert.deepEqual(files, ['log.jsonl'], `swept in other files: ${files.join(', ')}`);
  assert.match(git(root, 'show', 'HEAD', '--', 'log.jsonl'), /inbox-settled/);
  assert.equal(staged(root), '');
});

test('a git command that times out is recorded in log.jsonl with the command', async (t) => {
  const { hive, root } = await hiveWithStrays(t);
  const slow = path.join(root, '..', 'slow-git.js');
  fs.writeFileSync(slow, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes('commit')) setTimeout(() => {}, 5000);\nelse process.exit(require('child_process').spawnSync('git', a, { stdio: 'inherit' }).status ?? 1);\n`);
  fs.chmodSync(slow, 0o755);
  hive.gitBin = slow;
  hive.gitTimeoutMs = 300;
  hive.gitKillGraceMs = 200;
  hive.commit('hive: slow one', [path.join(root, 'stray-root.txt')]);
  await hive.flushGit();
  const events = fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const timeout = events.find((e) => e.kind === 'git-timeout');
  assert.ok(timeout, `no git-timeout event in log.jsonl: ${events.map((e) => e.kind).join(', ')}`);
  assert.match(timeout.message, /git timed out after 300 ms: git .*commit -q -m hive: slow one/);
});
