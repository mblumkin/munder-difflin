'use strict';
// AEON-3836: an archive in the app reaches registry.json and log.jsonl, and a
// released worker the registry archived never comes back as a live or
// restorable roster row (11-27: five finished workers reappeared "starting up").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { RosterStore, reconcileRosterWithRegistry } = loadTs('src/main/roster.ts');

async function floor(t, ids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-3836-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const id of ids) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  return { home, hive };
}
// The view index.ts builds for roster:read / roster:write, with no live PTYs.
const view = (hive, live = []) => ({
  archived: (id) => { const a = hive.registry().agents[id]; return a ? !!a.archived : undefined; },
  live: (id) => live.includes(id),
  godId: hive.registry().godId
});
const row = (id, extra = {}) => ({ id, name: id, cwd: '/hive', status: 'idle', action: 'starting up', ptyId: id, ...extra });
const snap = (parts) => ({ version: 1, savedAt: '', agents: [], archived: [], restorable: [], queues: {}, selectedId: null, ...parts });
const ids = (rows) => rows.map((r) => r.id).sort();

test('archiving rows in the app writes registry.json, logs archive events, and roster.json agrees', async (t) => {
  const workers = ['worker-w9001-a', 'worker-w9001-b', 'worker-w9001-c'];
  const { home, hive } = await floor(t, workers);
  // What the renderer's archiveAgent mirrors: the rows sit in `archived`, the PTYs
  // are long gone, and nothing has told the registry.
  const written = snap({ archived: workers.map((id) => row(id, { archived: true, action: 'archived' })) });

  const out = reconcileRosterWithRegistry(written, view(hive));
  for (const id of out.toArchive) hive.setArchived(id, true);   // the roster:write handler
  assert.equal(new RosterStore(() => home).write(out.snap).ok, true);

  const reg = JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'));
  const logged = fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'archive' && e.archived === true).map((e) => e.agentId);
  for (const id of workers) {
    assert.equal(reg.agents[id].archived, true, `${id} archived in registry.json`);
    assert.ok(logged.includes(id), `${id} has an archive event in log.jsonl`);
  }
  assert.deepEqual(ids(roster.archived), workers);
  assert.deepEqual(roster.agents, []);
  assert.equal(reg.agents['god-1'].archived, false, 'god is never archived');
});

test('a roster whose worker rows the registry archived restores and spawns none of them', async (t) => {
  const { hive } = await floor(t, ['worker-w9002-a', 'worker-w9002-b', 'worker-w9002-live', 'pam-1']);
  for (const id of ['worker-w9002-a', 'worker-w9002-b', 'pam-1']) hive.setArchived(id, true);
  const stale = snap({
    agents: [row('worker-w9002-a'), row('worker-w9002-live'), row('pam-1')],
    restorable: [row('worker-w9002-b')],
    selectedId: 'worker-w9002-a'
  });

  const { snap: loaded, toArchive } = reconcileRosterWithRegistry(stale, view(hive, ['worker-w9002-live']));

  assert.deepEqual(ids(loaded.agents), ['pam-1', 'worker-w9002-live'],
    'no registry-archived worker stays a live row; a startup-archived named agent stays restorable');
  assert.deepEqual(loaded.restorable, [], 'nothing left for the restore pass to spawn');
  assert.deepEqual(ids(loaded.archived), ['worker-w9002-a', 'worker-w9002-b']);
  for (const r of loaded.archived) {
    assert.equal(r.archived, true);
    assert.notEqual(r.action, 'starting up');
    assert.equal(r.ptyId, undefined);
  }
  assert.equal(loaded.selectedId, null);
  assert.deepEqual(toArchive, []);
});

test('the roster IPC handlers in index.ts reconcile every read and write', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /ipcMain\.on\('roster:readSync', \(evt\) => \{ evt\.returnValue = reconciledRoster\(\); \}\)/);
  assert.match(src, /ipcMain\.handle\('roster:read', \(\) => reconciledRoster\(\)\)/);
  assert.match(src, /ipcMain\.handle\('roster:write'[\s\S]{0,400}reconcileRosterWithRegistry[\s\S]{0,200}hive\.setArchived\(id, true\)/);
});
