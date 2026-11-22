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

for (const name of ELECTRON_TESTS) {
  test(`${name} skips without MUNDER_ELECTRON_TESTS and never spawns Electron`, () => {
    const trapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3713-')), 'spawns.txt');
    const env = { ...process.env, ELECTRON_TRAP_FILE: trapFile, NODE_OPTIONS: `--require=${TRAP}` };
    delete env.MUNDER_ELECTRON_TESTS;
    const r = spawnSync(process.execPath, [path.join(__dirname, name)], { env, encoding: 'utf8', timeout: 30_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!fs.existsSync(trapFile), `Electron spawn attempted:\n${fs.existsSync(trapFile) ? fs.readFileSync(trapFile, 'utf8') : ''}\n${out}`);
    assert.equal(r.status, 0, out);
    assert.match(out, /SKIP.*MUNDER_ELECTRON_TESTS=1/, out);
  });
}

test('every test that resolves the Electron binary goes through the opt-in gate', () => {
  const launchers = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.cjs') && f !== path.basename(__filename))
    .filter((f) => /require\((?:'electron'|path\.join\([^)]*'electron'\))\)/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepEqual(launchers.sort(), [...ELECTRON_TESTS].sort(), 'a new Electron-launching test must be gated and listed here');
  for (const f of launchers) assert.match(fs.readFileSync(path.join(__dirname, f), 'utf8'), /require\('\.\/electron-gate\.cjs'\)/, f);
});
