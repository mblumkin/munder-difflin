'use strict';

/**
 * AEON-2494: a worker's act:done archived it at once, so god's follow-up a few seconds later bounced with "no one is
 * there to answer" (worker-wcov at 04:24Z, the third time that night). A worker that signals done now stays reachable
 * for WORKER_DONE_GRACE_MS; a god message newer than the done re-engages it, and its next done starts a new window.
 * Drives the live ephemeralWorkerTick, workerDoneAt and workerFollowUpAfter bodies against real message files.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const NAMES = ['WORKER_DONE_GRACE_MS', 'workerFollowUpAfter', 'workerDoneAt', 'reapWorkerPty', 'ephemeralWorkerTick'];

function liveBodies() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const found = NAMES.map((name) => ast.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(ast) === name))));
  const missing = NAMES.filter((_, i) => !found[i]);
  assert.deepEqual(missing, [], 'act:done releases at once: no grace window or follow-up check in the live tick');
  return ts.transpileModule(`${found.map((n) => n.getText(ast)).join('\n')}\n({ ephemeralWorkerTick, WORKER_DONE_GRACE_MS })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2494-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'worker-wcov';
  const dirs = ['outbox', 'outbox/.sent', 'inbox', 'inbox/.done'].map((d) => path.join(root, 'agents', id, d));
  dirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  fs.mkdirSync(path.join(root, 'spawn-requests'));
  let clock = Date.parse('2026-10-21T04:24:00Z');
  const FakeDate = class extends Date { static now() { return clock; } };
  const rec = { workerId: id, reqId: 'r1', name: 'wcov', spawnedAt: clock - 600_000, releasing: false };
  const liveWorkers = new Map([[id, rec]]);
  const calls = { kill: [], teardown: [], notices: [] };
  const context = {
    liveWorkers, workerTickRunning: false, preservedWorktrees: new Map(), lastGcSweepAt: clock, GC_SWEEP_MS: 60_000,
    process, Date: FakeDate, Set, Math, JSON,
    console: { log() {}, warn() {}, error(e) { throw e; } },
    readConfig: () => ({ maxConcurrentWorkers: 4, workerIdleTimeoutMinutes: 20, orchestratorMaySpawn: false }),
    hive: { root: () => root, registry: () => ({ agents: {} }), settleInbox: () => ({ moved: 0, kept: 0, unanswered: [] }) },
    ptyManager: { idleFor: () => 0, queueWaitState: () => 'other', kill: (pid) => { calls.kill.push(pid); return { ok: true }; } },
    workerTokensUsed: () => 0, shouldReapIdleWorker: () => false,
    spawnRequestsDir: () => path.join(root, 'spawn-requests'),
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync, join: path.join,
    workerQueueOwners: () => [], workerTicketName: () => 'wcov', releaseWorkerQueueTickets: () => 0,
    signalDescendants() {}, forceRemainingDescendants() {}, setTimeout: () => ({ unref() {} }),
    teardownPty: (pid) => calls.teardown.push(pid), informGod: (...a) => calls.notices.push(a),
    describeUnpushed: () => '', unpushedWorkerBranches: () => [], workerWorktreesRoot: () => root,
  };
  const { ephemeralWorkerTick, WORKER_DONE_GRACE_MS } = vm.runInNewContext(liveBodies(), context);
  const write = (dir, name, msg) => fs.writeFileSync(path.join(root, 'agents', id, dir, `${name}.json`), JSON.stringify(msg));
  const at = (ms) => new Date(ms).toISOString();
  return {
    rec, calls, GRACE: WORKER_DONE_GRACE_MS, tick: ephemeralWorkerTick,
    now: () => clock, advance: (ms) => { clock += ms; },
    done: (name) => write('outbox/.sent', name, { from: id, to: 'god', act: 'done', created_at: at(clock) }),
    fromGod: (name, dir = 'inbox') => write(dir, name, { from: 'god', to: id, act: 'request', created_at: at(clock) }),
  };
}

test('a done worker stays reachable through the grace window, then is released', async (t) => {
  const h = harness(t);
  assert.ok(h.GRACE >= 60_000, `grace ${h.GRACE} ms is too short for god to answer a report`);
  h.done('d1');
  h.advance(12_000);
  await h.tick();
  assert.equal(h.rec.releasing, false, 'released 12 s after its done, so a follow-up would bounce');
  assert.deepEqual(h.calls.kill, []);
  h.advance(h.GRACE);
  await h.tick();
  assert.equal(h.rec.releasing, true, 'released once the window passes with no follow-up');
  assert.deepEqual(h.calls.kill, ['worker-wcov']);
});

test('a god message inside the window reaches the worker and keeps it until its next done', async (t) => {
  const h = harness(t);
  h.done('d1');
  h.advance(21_000);
  h.fromGod('followup');   // the 04:25:06Z follow-up, 21 s after done
  await h.tick();
  h.advance(h.GRACE + 60_000);
  await h.tick();
  assert.equal(h.rec.releasing, false, 'the follow-up re-engaged it; the old done does not release it');
  assert.deepEqual(h.calls.kill, []);
  h.done('d2');   // it answered the follow-up and is done again
  h.advance(h.GRACE + 1000);
  await h.tick();
  assert.equal(h.rec.releasing, true, 'its second done releases it after a fresh window');
});

test('a follow-up the worker already filed under inbox/.done still counts', async (t) => {
  const h = harness(t);
  h.done('d1');
  h.advance(5_000);
  h.fromGod('followup', 'inbox/.done');
  h.advance(h.GRACE + 1000);
  await h.tick();
  assert.equal(h.rec.releasing, false);
});
