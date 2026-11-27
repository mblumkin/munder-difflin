'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { linkWorktreeDeps, unlinkWorktreeDeps } = loadTs('src/main/worktreeDeps.ts');
const { removeWorktree } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worktree-deps-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const wtRoot = path.join(home, 'worktrees');
  fs.mkdirSync(wtRoot);
  return { repo, wtRoot };
}

function addWorktree(repo, wtRoot, name) {
  const wtPath = path.join(wtRoot, name);
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', `agent/${name}`, 'main');
  return wtPath;
}

test('links the base node_modules into an isolated worktree', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  fs.writeFileSync(path.join(baseNodeModules, 'sentinel.txt'), 'base\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-a');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: false });
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(worktreeNodeModules), baseNodeModules);
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'sentinel.txt'), 'utf8'), 'base\n');
});

test('skips linking when the base checkout has no node_modules', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = addWorktree(repo, wtRoot, 'agent-b');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
});

test('does not replace an existing worktree node_modules entry', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-c');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  fs.writeFileSync(path.join(worktreeNodeModules, 'own.txt'), 'own\n');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'own.txt'), 'utf8'), 'own\n');
});

test('does not follow the dependency symlink when removing a worktree', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  const sentinel = path.join(baseNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'still here\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-d');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true, 'symlink must exist before removal');
  assert.deepEqual(await removeWorktree(repo, wtPath), { ok: true });

  assert.equal(fs.existsSync(wtPath), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'still here\n');
});

test('leaves a dangling worktree dependency symlink untouched', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-e');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.symlinkSync('/does-not-exist', worktreeNodeModules);

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.readlinkSync(worktreeNodeModules), '/does-not-exist');
});

test('reports a failed link without throwing', async () => {
  const { repo } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const notADirectory = path.join(repo, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'file\n');

  const result = await linkWorktreeDeps(repo, notADirectory);

  assert.equal(result.ok, false);
  assert.match(result.error, /EEXIST|ENOTDIR/);
});

test('removes only the linked dependencies before checking worktree status', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  const wtPath = addWorktree(repo, wtRoot, 'agent-f');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  assert.notEqual(git(wtPath, 'status', '--porcelain'), '', 'the unignored link makes the worktree dirty');

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(worktreeNodeModules), /ENOENT/);
  assert.equal(git(wtPath, 'status', '--porcelain'), '', 'removing the link restores a clean worktree');
  assert.equal(fs.existsSync(baseNodeModules), true, 'the base dependencies must remain');
});

test('does not remove a real worktree node_modules directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-g');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  const sentinel = path.join(worktreeNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'worktree dependencies\n');

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isDirectory(), true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'worktree dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('does not remove a worktree node_modules link to another directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const foreignNodeModules = path.join(repo, 'foreign-node-modules');
  fs.mkdirSync(foreignNodeModules);
  const sentinel = path.join(foreignNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'foreign dependencies\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-h');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.symlinkSync(foreignNodeModules, worktreeNodeModules);

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(worktreeNodeModules), foreignNodeModules);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('wires dependency linking into successful isolated worktree creation', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const activeSource = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  assert.match(activeSource, /from ['"]\.\/worktreeDeps['"]/);
  const successBranch = activeSource.slice(
    activeSource.indexOf('if (wt.ok)'),
    activeSource.indexOf('} else {', activeSource.indexOf('if (wt.ok)'))
  );
  assert.match(successBranch, /await linkWorktreeDeps\(origCwd, wtPath\)/);
});

test('removes linked dependencies before worker retention checks', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const activeSource = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  const beforeRetention = activeSource.slice(0, activeSource.indexOf('const work = await worktreeHasUnintegratedWork'));
  assert.match(beforeRetention, /await unlinkWorktreeDeps\(origCwd, wtPath\)/);
  const beforeGc = activeSource.slice(0, activeSource.indexOf('safe = await worktreeIsGcSafe'));
  assert.match(beforeGc, /await unlinkWorktreeDeps\(e\.origCwd, e\.wtPath\)/);
});

test('uses a Windows junction for the directory link', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/worktreeDeps.ts'), 'utf8');

  assert.match(source, /process\.platform === ['"]win32['"] \? ['"]junction['"] :/);
});

// AEON-3751: the base checkout's node_modules was empty (or installed from a
// stale lockfile), so a linked worktree could not require('typescript') and ran
// no test. Link only deps that match the worktree's package-lock.json.
const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/typescript': { version: '5.6.3' },
    'node_modules/@esbuild/linux-x64': { version: '0.21.5', optional: true }
  }
};

function withLock(repo, wtRoot, name) {
  const wtPath = addWorktree(repo, wtRoot, name);
  fs.writeFileSync(path.join(wtPath, 'package-lock.json'), JSON.stringify(LOCK));
  return wtPath;
}

function recordingInstall(result = { ok: true }) {
  const calls = [];
  const install = async (dir) => { calls.push(dir); return result; };
  return { calls, install };
}

test('an empty base node_modules is never linked: the worktree installs its own deps', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = withLock(repo, wtRoot, 'agent-i');
  const { calls, install } = recordingInstall();

  const result = await linkWorktreeDeps(repo, wtPath, install);

  assert.deepEqual(result, { ok: true, skipped: false, installed: true });
  assert.deepEqual(calls, [wtPath], 'install runs in the worktree, never the base checkout');
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/, 'no link to the empty base');
});

test('a base installed from another lockfile is not linked either', async () => {
  const { repo, wtRoot } = makeHarness();
  const base = path.join(repo, 'node_modules');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, '.package-lock.json'), JSON.stringify({
    packages: { 'node_modules/typescript': { version: '5.4.0' } }
  }));
  const wtPath = withLock(repo, wtRoot, 'agent-j');
  const { calls, install } = recordingInstall();

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath, install), { ok: true, skipped: false, installed: true });
  assert.equal(calls.length, 1);
});

test('a base whose installed deps match the worktree lockfile is linked, optional absentees allowed', async () => {
  const { repo, wtRoot } = makeHarness();
  const base = path.join(repo, 'node_modules');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, '.package-lock.json'), JSON.stringify({
    packages: { 'node_modules/typescript': { version: '5.6.3' } }
  }));
  const wtPath = withLock(repo, wtRoot, 'agent-k');
  const { calls, install } = recordingInstall();

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath, install), { ok: true, skipped: false });
  assert.deepEqual(calls, []);
  assert.equal(fs.readlinkSync(path.join(wtPath, 'node_modules')), base);
});

test('a failed worktree install is reported loudly with the manual step', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = withLock(repo, wtRoot, 'agent-l');
  const { install } = recordingInstall({ ok: false, error: 'spawn npm ENOENT' });

  const result = await linkWorktreeDeps(repo, wtPath, install);

  assert.equal(result.ok, false);
  assert.match(result.error, /does not match .*package-lock\.json/);
  assert.match(result.error, /npm ci --ignore-scripts/);
  assert.match(result.error, /spawn npm ENOENT/);
});

// --ignore-scripts skips the repo's postinstall (tools/ensure-pty-perms.cjs), so
// node-pty's prebuilt spawn-helper stays 644 and every pty spawn fails
// "posix_spawnp failed". An install into the worktree must restore +x.
test('a worktree install leaves node-pty spawn-helper executable', { skip: process.platform === 'win32' }, async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = withLock(repo, wtRoot, 'agent-m');
  const helpers = ['prebuilds/darwin-arm64', 'build/Release'].map((d) => path.join(wtPath, 'node_modules/node-pty', d, 'spawn-helper'));
  const install = async (dir) => {
    for (const h of helpers) { fs.mkdirSync(path.dirname(h), { recursive: true }); fs.writeFileSync(h, '', { mode: 0o644 }); }
    return { ok: true, dir };
  };

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath, install), { ok: true, skipped: false, installed: true });
  for (const h of helpers) assert.equal(fs.statSync(h).mode & 0o111, 0o111, `${h} must be executable`);
});
