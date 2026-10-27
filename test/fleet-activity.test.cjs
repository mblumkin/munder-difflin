'use strict';

// AEON-2675: the LIVE ROSTER read a working Codex seat as "a fresh harness, no
// activity yet" with 0 tokens. fleet.json took lastActiveSecAgo from Claude
// telemetry only, so any other engine looked dead and was re-paged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { fleetActivity } = loadTs('src/main/workerWake.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const NOW = 2_000_000_000;

test('a seat with turn hooks and no telemetry reads as active, from the hooks', () => {
  assert.deepEqual(fleetActivity(undefined, NOW - 17 * 60_000, NOW), { lastActiveSecAgo: 1020, lastActiveSource: 'hooks' });
});

test('the later of telemetry and hooks wins, and names its source', () => {
  assert.deepEqual(fleetActivity(NOW - 5_000, NOW - 60_000, NOW), { lastActiveSecAgo: 5, lastActiveSource: 'telemetry' });
  assert.deepEqual(fleetActivity(NOW - 60_000, NOW - 5_000, NOW), { lastActiveSecAgo: 5, lastActiveSource: 'hooks' });
});

test('a seat with neither signal still reads as no activity', () => {
  assert.deepEqual(fleetActivity(undefined, 0, NOW), { lastActiveSecAgo: null, lastActiveSource: null });
  assert.deepEqual(fleetActivity(null, 0, NOW), { lastActiveSecAgo: null, lastActiveSource: null });
});

test('the roster shows a hook-only seat as active and drops the placeholder role', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-activity-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [
      { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, tokens: 1000, lastActiveSecAgo: 6, lastActiveSource: 'telemetry' },
      { id: 'pam-1', name: 'Pam', role: 'a fresh harness', tokens: 0, lastActiveSecAgo: 1020, lastActiveSource: 'hooks', inboxBacklog: 1 },
      { id: 'kev-1', name: 'Kevin', role: 'a fresh harness', tokens: 0, lastActiveSecAgo: null, lastActiveSource: null }
    ]
  });
  const line = hive.rosterContext();
  assert.match(line, /pam-1 "Pam" \(agent, active 17m ago \(hooks\), inbox 1\)/);
  assert.match(line, /god-1 "Michael" \(orchestrator, active 6s ago,/, 'a telemetry clock carries no label');
  assert.match(line, /kev-1 "Kevin" \(agent, no activity yet\)/);
  assert.doesNotMatch(line, /fresh harness/);
});
