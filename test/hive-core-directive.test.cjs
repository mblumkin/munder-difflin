'use strict';

// Every spawned agent (god, worker, assistant) must get the fix-or-card core directive in its
// boot prompt: POLICY.md alone reaches only agents that happen to read it (AEON-1608).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0, 'the hive protocol must be on argv');
  return inj.args[i + 1];
}

for (const [label, meta] of [['god', { isGod: true }], ['worker', {}], ['assistant', { isAssistant: true }]]) {
  test(`the ${label} boot prompt carries the fix-or-card core directive`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-coredir-'));
    const hive = new HiveManager(() => home);
    t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
    const inj = await hive.ensureAgent({ id: `${label}-1`, name: 'X', provider: 'claude', cwd: home, ...meta }, {});
    const prompt = promptOf(inj);
    assert.ok(prompt.includes('CORE DIRECTIVE — fix or card everything you find along the way'));
    assert.ok(prompt.includes('Walking past it is prohibited'));
  });
}
