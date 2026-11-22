'use strict';
// AEON-3715: a HiveManager built on a temp home still resolves the user's Codex
// home through os.homedir(), so a test that creates a codex agent without also
// redirecting HOME writes into the real ~/.codex (exposeCodexDataDirs mkdirs
// sessions/ and archived_sessions/munder-difflin/<hash> there). Each such test
// file runs here under a planted HOME, which must come back with no .codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const codexAgentTests = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.cjs') && f !== path.basename(__filename))
  .filter((f) => {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    return /new HiveManager\(/.test(src) && /provider: 'codex'/.test(src);
  });

test('the scan finds the codex-agent test files', () => {
  assert.ok(codexAgentTests.includes('auto-mode-sandbox.test.cjs'), codexAgentTests.join(', '));
});

for (const f of codexAgentTests) {
  test(`${f} leaves the caller's HOME/.codex untouched`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3715-home-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.NODE_TEST_CONTEXT; // inherited, it makes the child runner report upward and run nothing here
      const r = spawnSync(process.execPath, ['--test', path.join(__dirname, f)], { env, encoding: 'utf8', timeout: 120_000 });
      // Not its exit status: some of these fail in a sandboxed seat for unrelated reasons.
      assert.match(r.stdout, /# pass [1-9]/, `${f} ran no tests:\n${r.stdout}${r.stderr}`);
      assert.deepEqual(fs.readdirSync(home), [], `${f} wrote into the caller's home`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
