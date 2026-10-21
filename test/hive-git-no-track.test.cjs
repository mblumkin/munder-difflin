'use strict';

/**
 * AEON-2498: an agent's sandbox cannot write the shared repo config, and `git checkout -b X origin/Y`
 * writes branch tracking there after it has already switched the index and tree, so the failure left
 * HEAD on the old branch over the new tree. Agents get branch.autoSetupMerge=false through git's
 * environment config, so that checkout never writes the config at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function agentEnv(t, id) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-no-track-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  const inj = await hive.ensureAgent({ id, name: 'Creed', provider: 'claude', cwd: home }, {});
  return { home, env: inj.env };
}

test('an agent checking out a new branch from origin/<b> writes no tracking config', async (t) => {
  const { home, env } = await agentEnv(t, 'worker-1');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const origin = path.join(home, 'origin.git');
  const seed = path.join(home, 'seed');
  git(home, 'init', '-q', '--bare', origin);
  git(home, 'init', '-q', seed);
  fs.writeFileSync(path.join(seed, 'f.txt'), 'x\n');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'f.txt');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'HEAD:refs/heads/feature');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '-q', origin, clone);
  const before = fs.readFileSync(path.join(clone, '.git', 'config'), 'utf8');

  git(clone, 'checkout', '-q', '-b', 'mine', 'origin/feature');

  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'mine');
  assert.equal(fs.readFileSync(path.join(clone, '.git', 'config'), 'utf8'), before, 'the checkout wrote the repo config');
});

test('the setting appends to git config the parent environment already carries', async (t) => {
  const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '9' });
  t.after(() => {
    for (const [k, v] of [['GIT_CONFIG_COUNT', saved.c], ['GIT_CONFIG_KEY_0', saved.k], ['GIT_CONFIG_VALUE_0', saved.v]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const { env } = await agentEnv(t, 'worker-2');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_1, 'branch.autoSetupMerge');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'false');
  assert.equal(env.GIT_CONFIG_KEY_0, undefined, 'the inherited entry stays as the parent set it');
});
