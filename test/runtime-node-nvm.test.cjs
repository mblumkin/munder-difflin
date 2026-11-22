'use strict';
// AEON-3716: bin/runtime/node (APPENDED to every seat PATH) used to be Electron
// as node unconditionally, so a seat started with the bare system PATH ran the
// app's Electron node (v24) instead of the repo's nvm node. The shim now prefers
// nvm's node for the nearest .nvmrc, then nvm's default alias, then the newest
// nvm node, and runs Electron as node only when no nvm node exists.
// Runs the shim under a bare env with a planted temp HOME; never the real ~/.nvm
// and never Electron (the fallback execPath here is this test's own node).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const POSIX = process.platform !== 'win32';
const BARE = '/usr/bin:/bin:/usr/sbin:/sbin';

async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-nvm-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const plantNode = (nvmDir, ver) => {
    const bin = path.join(nvmDir, 'versions', 'node', `v${ver}`, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "nvm-node ${ver} ELECTRON_RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE:-unset} $*"\n`, { mode: 0o755 });
  };
  const project = path.join(home, 'repo', 'sub');
  fs.mkdirSync(project, { recursive: true });
  const run = (env, cwd = project, args = '--version') => {
    const r = spawnSync('/bin/sh', ['-c', `cd "${cwd}" && node ${args}`],
      { env: { PATH: `${BARE}:${hive.runtimeBinDir()}`, HOME: home, ...env }, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
  };
  return { home, project, plantNode, run, nvm: path.join(home, '.nvm') };
}

test('bare PATH: node is nvm\'s node matching the nearest .nvmrc, not Electron', { skip: !POSIX }, async (t) => {
  const { home, plantNode, run, nvm } = await setup(t);
  for (const v of ['20.11.0', '22.9.0', '22.23.2', '24.1.0']) plantNode(nvm, v);
  fs.writeFileSync(path.join(home, 'repo', '.nvmrc'), 'v22\n');
  const r = run({});
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, 'nvm-node 22.23.2 ELECTRON_RUN_AS_NODE=unset --version');
});

test('no .nvmrc: nvm\'s default alias, then the newest nvm node', { skip: !POSIX }, async (t) => {
  const { plantNode, run, nvm } = await setup(t);
  for (const v of ['20.11.0', '22.23.2', '24.1.0']) plantNode(nvm, v);
  assert.match(run({}).out, /^nvm-node 24\.1\.0 /, 'no .nvmrc and no default: the newest nvm node');
  fs.mkdirSync(path.join(nvm, 'alias'), { recursive: true });
  fs.writeFileSync(path.join(nvm, 'alias', 'default'), '20\n');
  assert.match(run({}).out, /^nvm-node 20\.11\.0 /);
});

test('an .nvmrc nvm cannot satisfy still prefers an nvm node over Electron', { skip: !POSIX }, async (t) => {
  const { home, plantNode, run, nvm } = await setup(t);
  plantNode(nvm, '22.23.2');
  fs.writeFileSync(path.join(home, 'repo', '.nvmrc'), 'lts/*\n');
  assert.match(run({}).out, /^nvm-node 22\.23\.2 /);
});

test('NVM_DIR is honoured', { skip: !POSIX }, async (t) => {
  const { home, plantNode, run } = await setup(t);
  const custom = path.join(home, 'elsewhere-nvm');
  plantNode(custom, '22.1.0');
  assert.match(run({ NVM_DIR: custom }).out, /^nvm-node 22\.1\.0 /);
});

test('no nvm node at all: falls back to Electron as node, which still runs', { skip: !POSIX }, async (t) => {
  const { run } = await setup(t);
  const r = run({}, undefined, `-p "process.version + ' ' + process.env.ELECTRON_RUN_AS_NODE"`);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, `${process.version} 1`);
});
