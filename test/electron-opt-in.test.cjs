'use strict';
// AEON-3713: a seat-run suite must never boot Electron. Each Electron-launching
// test skips unless MUNDER_ELECTRON_TESTS=1. The trap preload fakes win32 and
// throws on any Electron spawn, so this test cannot start Electron itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRAP = path.join(__dirname, 'fixtures', 'electron-spawn-trap.cjs');
const ELECTRON_TESTS = [
  'aeon1609-electron-surfaces.test.cjs',
  'quit-sweep.electron.test.cjs',
  'restart-terminal-preserve.test.cjs',
];
// Loaded before the trap in every probe, so a trap that starts electron's download
// fails here instead of forking install.js without bound.
const INSTALL_GUARD = path.join(__dirname, 'fixtures', 'electron-install-guard.cjs');

function probe(name, trap = TRAP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3713-'));
  const spawnFile = path.join(dir, 'spawns.txt');
  const installFile = path.join(dir, 'installs.txt');
  const env = { ...process.env, ELECTRON_TRAP_FILE: spawnFile, ELECTRON_INSTALL_FILE: installFile,
    NODE_OPTIONS: `--require=${INSTALL_GUARD} --require=${trap}` };
  delete env.MUNDER_ELECTRON_TESTS;
  const r = spawnSync(process.execPath, [path.join(__dirname, name)], { env, encoding: 'utf8', timeout: 30_000 });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const res = { status: r.status, out: `${r.stdout}${r.stderr}`, spawns: read(spawnFile), installs: read(installFile) };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

// A launch is require() of electron itself (either quote style, or a path.join to
// it); require.resolve('electron') only stubs the module and is not one.
const LAUNCHES_ELECTRON = /require\(\s*(?:(['"])electron\1|path\.join\([^)]*(['"])electron\2\))\s*\)/;
const tmpProbeDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('aeon3713-')).length;

for (const name of ELECTRON_TESTS) {
  test(`${name} skips without MUNDER_ELECTRON_TESTS and never spawns Electron`, () => {
    const r = probe(name);
    assert.equal(r.spawns, null, `Electron spawn attempted:\n${r.spawns}\n${r.out}`);
    assert.equal(r.installs, null, `electron install.js spawn attempted:\n${r.installs}\n${r.out}`);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SKIP.*MUNDER_ELECTRON_TESTS=1/, r.out);
  });
}

test('with no Electron binary downloaded, the trap never spawns electron install.js', () => {
  // What a fresh `npm ci` leaves: electron's index.js with no dist/ or path.txt, so
  // require('electron') would spawn install.js to download.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3713-nodist-'));
  const pkg = path.join(dir, 'node_modules', 'electron');
  fs.mkdirSync(pkg, { recursive: true });
  const real = path.dirname(require.resolve('electron/package.json'));
  for (const f of ['package.json', 'index.js']) fs.copyFileSync(path.join(real, f), path.join(pkg, f));
  const trap = path.join(dir, 'electron-spawn-trap.cjs');
  fs.copyFileSync(TRAP, trap);
  const r = probe(ELECTRON_TESTS[0], trap);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.installs, null, `electron install.js spawn attempted:\n${r.installs}\n${r.out}`);
  assert.equal(r.spawns, null, `Electron spawn attempted:\n${r.spawns}\n${r.out}`);
  assert.equal(r.status, 0, r.out);
});

test('every test that resolves the Electron binary goes through the opt-in gate', () => {
  const launchers = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.cjs') && f !== path.basename(__filename))
    .filter((f) => LAUNCHES_ELECTRON.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepEqual(launchers.sort(), [...ELECTRON_TESTS].sort(), 'a new Electron-launching test must be gated and listed here');
  for (const f of launchers) assert.match(fs.readFileSync(path.join(__dirname, f), 'utf8'), /require\('\.\/electron-gate\.cjs'\)/, f);
});

test('the launcher detector sees either quote style and a path.join, not require.resolve', () => {
  for (const src of ["require('electron')", 'require("electron")', "require( 'electron' )",
    "require(path.join(REPO, 'node_modules', 'electron'))", 'require(path.join(REPO, "node_modules", "electron"))']) {
    assert.match(src, LAUNCHES_ELECTRON, src);
  }
  for (const src of ["require.resolve('electron')", "require('electron-builder')", "require('./electron-gate.cjs')"]) {
    assert.doesNotMatch(src, LAUNCHES_ELECTRON, src);
  }
});

test('the trap refuses an Electron launch through exec and execSync too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3713-exec-'));
  const spawnFile = path.join(dir, 'spawns.txt');
  // echo only: should the trap let it through, nothing is launched.
  const script = "const cp=require('node:child_process');for(const f of [()=>cp.execSync('echo electron-probe'),()=>cp.exec('echo electron-probe',()=>{})]){try{f()}catch{}}";
  const r = spawnSync(process.execPath, ['-e', script],
    { env: { ...process.env, ELECTRON_TRAP_FILE: spawnFile, NODE_OPTIONS: `--require=${TRAP}` }, encoding: 'utf8', timeout: 30_000 });
  const spawns = fs.existsSync(spawnFile) ? fs.readFileSync(spawnFile, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(spawns, ['echo electron-probe', 'echo electron-probe']);
});

test('a probe leaves no aeon3713-* directory behind in the temp dir', () => {
  const before = tmpProbeDirs();
  probe(ELECTRON_TESTS[0]);
  assert.equal(tmpProbeDirs(), before);
});
