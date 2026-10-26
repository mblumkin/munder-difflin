'use strict';
// AEON-2559: a respawn that clears an agent's archived flag says so in log.jsonl.
//
// At app start every live agent is archived (log: archive archived:true), then respawned. ensureAgent
// cleared the flag inside its registry upsert and logged only `spawn`, so the log read "archived" for
// agents the roster showed as live. Closing a tab and reopening it showed the same gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-unarchive-log-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  return { home, hive };
}

const archiveEvents = (hive, id) => hive.logTail(500).filter((e) => e.kind === 'archive' && e.agentId === id);

test('a respawn of an archived agent logs archived:false, so the log agrees with the registry', async (t) => {
  const { hive } = await floor(t);
  const meta = { id: 'pam-1', name: 'Pam', provider: 'claude', cwd: os.tmpdir() };
  await hive.ensureAgent(meta);
  hive.setArchived('pam-1', true);
  await hive.ensureAgent(meta);

  assert.equal(hive.registry().agents['pam-1'].archived, false, 'the respawn cleared the flag');
  assert.deepEqual(archiveEvents(hive, 'pam-1').map((e) => e.archived), [true, false],
    'the log records the archive and then the respawn clearing it');
  const log = hive.logTail(500).filter((e) => e.agentId === 'pam-1').map((e) => e.kind);
  assert.ok(log.lastIndexOf('archive') < log.lastIndexOf('spawn'), 'the unarchive is logged before its spawn line');
});

test('red control: a first spawn and a respawn of a live agent log no archive event', async (t) => {
  const { hive } = await floor(t);
  const meta = { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: os.tmpdir() };
  await hive.ensureAgent(meta);
  await hive.ensureAgent(meta);
  assert.deepEqual(archiveEvents(hive, 'jim-1'), []);
});
