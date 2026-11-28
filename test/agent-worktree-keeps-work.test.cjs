'use strict';

/**
 * AEON-3843: a normal agent's isolated worktree keeps uncommitted work when the agent
 * ends. A crash, a circuit-breaker stop and a Restart all reach teardownPty, which used
 * to `git worktree remove --force` the tree. Workers already had a gate; normal agents
 * did not.
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
const root = path.resolve(__dirname, '..');

async function agentTree(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3843-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const wtPath = path.join(home, 'worktrees', 'agent-x');
  const res = await addWorktree(repo, wtPath, 'main');
  assert.equal(res.ok, true, `addWorktree failed: ${res.error}`);
  return { repo, wtPath };
}

test('a dirty tree is kept with its edits and its new files', async (t) => {
  const { finalizeAgentWorktree } = loadTs('src/main/agentWorktree.ts');
  const { repo, wtPath } = await agentTree(t);
  fs.writeFileSync(path.join(wtPath, 'a.txt'), 'half an edit\n');
  fs.writeFileSync(path.join(wtPath, 'new.txt'), 'not yet added\n');

  const out = await finalizeAgentWorktree(wtPath, repo);

  assert.equal(out.fate, 'kept', out.detail);
  assert.equal(fs.readFileSync(path.join(wtPath, 'a.txt'), 'utf8'), 'half an edit\n');
  assert.equal(fs.readFileSync(path.join(wtPath, 'new.txt'), 'utf8'), 'not yet added\n');
});

test('a clean tree is removed and its commits stay on the branch', async (t) => {
  const { finalizeAgentWorktree } = loadTs('src/main/agentWorktree.ts');
  const { repo, wtPath } = await agentTree(t);
  fs.writeFileSync(path.join(wtPath, 'b.txt'), 'committed\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'work');
  const head = git(wtPath, 'rev-parse', 'HEAD');

  const out = await finalizeAgentWorktree(wtPath, repo);

  assert.equal(out.fate, 'removed', out.detail);
  assert.equal(fs.existsSync(wtPath), false);
  assert.equal(git(repo, 'rev-parse', 'agent/agent-x'), head);
});

test('a tree git cannot read is kept', async (t) => {
  const { finalizeAgentWorktree } = loadTs('src/main/agentWorktree.ts');
  const { repo, wtPath } = await agentTree(t);
  fs.writeFileSync(path.join(wtPath, 'a.txt'), 'edit\n');
  fs.writeFileSync(path.join(wtPath, '.git'), 'gitdir: /nonexistent/aeon3843\n');

  const out = await finalizeAgentWorktree(wtPath, repo);

  assert.equal(out.fate, 'kept', out.detail);
  assert.equal(fs.readFileSync(path.join(wtPath, 'a.txt'), 'utf8'), 'edit\n');
});

test('every ending of a normal agent goes through the gate, never a bare remove', () => {
  const src = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const start = src.indexOf('function teardownPty(');
  assert.ok(start > 0, 'teardownPty exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  // The crash (onExit), the breaker stop, pty:kill (Stop and Restart) and the voice
  // kill all call teardownPty, so its normal-agent branch is the one place to guard.
  assert.match(body, /finalizeAgentWorktree\(/);
  assert.doesNotMatch(body, /removeWorktree\(/);
});
