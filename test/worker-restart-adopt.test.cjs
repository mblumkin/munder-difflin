'use strict';

/**
 * AEON-3764: liveWorkers lived in memory only, so after an app restart a worker whose card the renderer restored was a
 * plain agent: its act:done never released it, the idle reaper and token cap never fired, and it did not count toward
 * maxConcurrentWorkers (2026-11-22: four done workers stayed registered for up to 2 h until god culled them by hand).
 * Simulates a restart: liveWorkers starts EMPTY, the restored ptys are live, the hirings sit in spawn-requests/.done.
 * Drives the live ephemeralWorkerTick (and its adoption step, when there is one) against real files.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// AEON-3727's ephemeralWorkerTick calls workerUnreadGodRequests; a body the vm lacks throws as '[worker] tick error:'.
const REQUIRED = ['WORKER_DONE_GRACE_MS', 'workerFollowUpAfter', 'workerUnreadGodRequests', 'workerDoneAt', 'reapWorkerPty', 'ephemeralWorkerTick'];
const OPTIONAL = ['adoptChecked', 'adoptRestoredWorkers'];
const rehydratePath = path.resolve(__dirname, '..', 'src/main/workerRehydrate.ts');

function liveBodies() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const find = (name) => ast.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(ast) === name)));
  const missing = REQUIRED.filter((name) => !find(name));
  assert.deepEqual(missing, [], 'the live tick bodies moved');
  const found = [...REQUIRED, ...OPTIONAL].map(find).filter(Boolean);
  return ts.transpileModule(`${found.map((n) => n.getText(ast)).join('\n')}\n({ ephemeralWorkerTick, WORKER_DONE_GRACE_MS })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function harness(t, { idleMs = 0, used = 0, registry } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon3764-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-22T19:00:00Z');
  const FakeDate = class extends Date { static now() { return clock; } };
  const done = path.join(root, 'spawn-requests', '.done');
  fs.mkdirSync(done, { recursive: true });
  const hire = (reqId, extra = {}, file = `${reqId}.json`, at = clock - 3_600_000) => {
    const id = `worker-${reqId}`;
    for (const d of ['outbox/.sent', 'inbox/.done']) fs.mkdirSync(path.join(root, 'agents', id, d), { recursive: true });
    const fp = path.join(done, file);
    fs.writeFileSync(fp, JSON.stringify({ name: id, cwd: root, objective: 'o', ...extra }));
    fs.utimesSync(fp, at / 1000, at / 1000);   // the archive rename keeps the request's write time
    return id;
  };
  const ptys = [];
  const liveWorkers = new Map();   // a restart: nothing in memory
  const calls = { kill: [], teardown: [], notices: [] };
  const rehydrate = fs.existsSync(rehydratePath) ? require('./load-ts.cjs')(rehydratePath) : {};
  const context = {
    liveWorkers, workerTickRunning: false, preservedWorktrees: new Map(), lastGcSweepAt: clock, GC_SWEEP_MS: 60_000,
    process, Date: FakeDate, Set, Map, Math, JSON, Object,
    // The tick logs '[worker] tick error:', e: throw e itself, or a body missing from the vm hides behind that label.
    console: { log() {}, warn() {}, error(label, e) { throw e ?? label; } },
    readConfig: () => ({ maxConcurrentWorkers: 4, workerIdleTimeoutMinutes: 20, orchestratorMaySpawn: false, defaultWorkerTokenCap: 0 }),
    hive: { root: () => root, registry: () => ({ agents: registry ?? Object.fromEntries(ptys.map((id) => [id, { id, archived: false }])) }),
      settleInbox: () => ({ moved: 0, kept: 0, unanswered: [] }) },
    ptyManager: { list: () => ptys.map((id) => ({ id })), idleFor: () => idleMs, queueWaitState: () => 'other',
      kill: (pid) => { calls.kill.push(pid); return { ok: true }; } },
    workerTokensUsed: () => used,
    shouldReapIdleWorker: (_root, _id, _spawnedAt, idle, timeout) => idle > timeout,
    spawnRequestsDir: () => path.join(root, 'spawn-requests'),
    findWorkerHiring: rehydrate.findWorkerHiring, getBranch: async () => ({ current: 'main' }),
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync, join: path.join,
    workerQueueOwners: () => [], workerTicketName: () => 't', releaseWorkerQueueTickets: () => 0,
    signalDescendants() {}, forceRemainingDescendants() {}, setTimeout: () => ({ unref() {} }),
    teardownPty: (pid) => { calls.teardown.push(pid); liveWorkers.delete(pid); }, informGod: (...a) => calls.notices.push(a),
    describeUnpushed: () => '', unpushedWorkerBranches: () => [], workerWorktreesRoot: () => root,
  };
  const { ephemeralWorkerTick, WORKER_DONE_GRACE_MS } = vm.runInNewContext(liveBodies(), context);
  return {
    root, liveWorkers, calls, ptys, hire, GRACE: WORKER_DONE_GRACE_MS, tick: ephemeralWorkerTick,
    advance: (ms) => { clock += ms; }, now: () => clock,
    doneAt: (id, ms) => fs.writeFileSync(path.join(root, 'agents', id, 'outbox', '.sent', `d${ms}.json`),
      JSON.stringify({ from: id, to: 'god', act: 'done', created_at: new Date(ms).toISOString() })),
  };
}

test('after a restart, a restored worker that sent done before it is released once the grace has passed', async (t) => {
  const h = harness(t);
  const id = h.hire('w22-verify5');
  h.ptys.push(id);
  h.doneAt(id, h.now() - h.GRACE - 60_000);   // done before the restart, the grace already over
  await h.tick();
  assert.deepEqual(h.calls.kill, [id], 'a worker that signaled done before the restart was never released');
});

test('after a restart, a restored worker idle past the timeout is reaped, and one inside its grace is kept', async (t) => {
  const h = harness(t, { idleMs: 25 * 60_000 });
  const idle = h.hire('w22-floor');
  const recent = h.hire('w22-member');
  h.ptys.push(idle, recent);
  h.doneAt(recent, h.now() - 10_000);   // still inside its grace window: reachable, not reaped
  await h.tick();
  assert.deepEqual(h.calls.kill, [idle], 'only the idle worker is killed');
  assert.ok(h.calls.notices.some(([subject]) => subject === `[worker reaped — idle] ${idle}`),
    'a worker idle past the timeout after a restart was never reaped');
  assert.ok(!h.calls.notices.some(([subject]) => subject.includes(recent)), 'a worker inside its done grace was reaped');
});

test('after a restart, the token cap from the spawn request is enforced', async (t) => {
  const h = harness(t, { used: 2_000_000 });
  const capped = h.hire('w22-guards2', { tokenCap: 1_000_000 });
  h.ptys.push(capped);
  await h.tick();
  assert.ok(h.calls.notices.some(([subject]) => subject === `[worker reaped — token cap] ${capped}`),
    'the per-request token cap was not enforced after a restart');
});

test('control: only hired, unarchived worker ptys are adopted, with the spawn request\'s own time as spawnedAt', async (t) => {
  const h = harness(t, { registry: { 'worker-gone': { archived: true }, 'worker-hired': {}, 'worker-nohire': {}, 'pam-x': {} } });
  h.hire('gone');
  const hired = h.hire('hired', { id: 'hired', slack: { channel: 'C1', thread_ts: '1.2' } }, 'renamed-file.json');
  h.ptys.push('worker-gone', hired, 'worker-nohire', 'pam-x');
  await h.tick();
  if (!h.liveWorkers.has(hired)) assert.fail('a hired worker\'s restored pty was not adopted');
  assert.deepEqual([...h.liveWorkers.keys()], [hired], 'an archived, unhired or non-worker pty was adopted');
  // liveWorkers.size is what maxConcurrentWorkers counts, so an adopted worker holds a seat again.
  const rec = h.liveWorkers.get(hired);
  assert.equal(rec.reqId, 'hired');
  assert.equal(rec.spawnedAt, h.now() - 3_600_000, 'spawnedAt is not the hiring\'s time, so a pre-restart done is missed');
  assert.deepEqual(rec.slack, { channel: 'C1', thread_ts: '1.2' });
  assert.equal(rec.baseBranch, 'main');
});
