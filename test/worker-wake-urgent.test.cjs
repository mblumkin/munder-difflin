// AEON-3619: urgent mail reaches a worker that is mid-turn, at its next tool
// boundary, instead of waiting for a turn that can run an hour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { WorkerWakeWatchdog, isUrgentMessage, urgentSteerText } = loadTs('src/main/workerWake.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');

const now = 10_000_000;
function busy(overrides = {}) {
  return {
    agentId: 'w1', ptyId: 'pty-w1', lastOutputAt: now - 1000, inboxIds: ['m-urgent'],
    autoDeliveryPaused: false, paused: false, halted: false, ...overrides
  };
}
const urgent = { id: 'm-urgent', from: 'god', subject: 'URGENT: stop heavy runs', body: 'disk at 200 MB, kill member-check now' };
const plain = { id: 'm-plain', from: 'god', subject: 'status', body: 'fyi' };

test('urgent is a subject that starts with URGENT, or priority "urgent"', () => {
  assert.equal(isUrgentMessage(urgent), true);
  assert.equal(isUrgentMessage({ id: 'x', subject: '[urgent] disk' }), true);
  assert.equal(isUrgentMessage({ id: 'x', subject: 'status', priority: 'Urgent' }), true);
  assert.equal(isUrgentMessage(plain), false);
  assert.equal(isUrgentMessage({ id: 'x', subject: 'not urgent at all' }), false);
});

test('a mid-turn worker is held from the typed nudge but gets the urgent message as a steer at its next tool boundary', () => {
  const w = new WorkerWakeWatchdog();
  const control = new ControlRegistry();
  const f = busy({ inboxIds: ['m-plain', 'm-urgent'] });
  assert.equal(w.explain(f, now), 'mid-turn');
  const out = w.takeUrgent(f, [plain, urgent]);
  assert.deepEqual(out.map((m) => m.id), ['m-urgent']);
  for (const m of out) control.steer(f.agentId, urgentSteerText(m));
  // HookServer takes one steer per PostToolUse: the very next tool call.
  const note = control.takeSteer('w1');
  assert.match(note, /URGENT hive message m-urgent from god/);
  assert.match(note, /kill member-check now/);
  assert.equal(control.takeSteer('w1'), undefined);
});

test('each urgent id is steered once, and again only after it left and came back', () => {
  const w = new WorkerWakeWatchdog();
  assert.equal(w.takeUrgent(busy(), [urgent]).length, 1);
  assert.equal(w.takeUrgent(busy(), [urgent]).length, 0);
  assert.equal(w.takeUrgent(busy({ inboxIds: [] }), []).length, 0);
  assert.equal(w.takeUrgent(busy(), [urgent]).length, 1);
});

test('only god (by registry id) or the human may steer a worker mid-turn', () => {
  const w = new WorkerWakeWatchdog();
  const fromWorker = { ...urgent, id: 'm-w2', from: 'worker-w2' };
  const fromHuman = { ...urgent, id: 'm-h', from: 'human' };
  const fromNamedGod = { ...urgent, id: 'm-g', from: 'michael' };
  assert.deepEqual(w.takeUrgent(busy(), [fromWorker, urgent, fromHuman]).map((m) => m.id), ['m-urgent', 'm-h']);
  assert.deepEqual(w.takeUrgent(busy(), [fromNamedGod], 'michael').map((m) => m.id), ['m-g']);
  assert.equal(w.takeUrgent(busy(), [{ ...urgent, id: 'm-x' }], 'michael').length, 0, "'god' is not god when the registry names another id");
});

test('the beat passes the registry god id to takeUrgent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /workerWake\.takeUrgent\(f, mailByAgent\.get\(f\.agentId\) \?\? \[\], reg\.godId\)/);
});

test('god, a paused, halted or delivery-paused worker gets no urgent steer', () => {
  const w = new WorkerWakeWatchdog();
  for (const o of [{ isGod: true }, { paused: true }, { halted: true }, { autoDeliveryPaused: true }]) {
    assert.equal(w.takeUrgent(busy(o), [urgent]).length, 0, JSON.stringify(o));
  }
});

test('the worker-wake beat queues urgent mail as a control steer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const beat = src.slice(src.indexOf('function runWorkerWakeBeat'), src.indexOf('function armAlwaysOnBeats'));
  assert.match(beat, /workerWake\.takeUrgent\(f, [^\n]*\)\) \{\s*control\.steer\(f\.agentId, urgentSteerText\(m\)\)/);
});
