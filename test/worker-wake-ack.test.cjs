'use strict';

// AEON-2660: a typed wake counts as heard only when the worker's CLI answers it
// with a UserPromptSubmit. Live 2026-10-27: a nudge typed while the worker was
// mid-turn sat unsubmitted in its input box for 58 minutes. The Enter write had
// succeeded, so its id was announced and never retyped, and the stall rule read
// the rest of that same turn as work on the mail.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  WorkerWakeWatchdog,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_COOLDOWN_MS
} = loadTs('src/main/workerWake.ts');

const ACK_MS = 10_000;
const T0 = 1_000_000;
const MAIL_AT = T0 + 5_000;
const TURN_END = MAIL_AT + 8 * 60_000;

function fact(overrides = {}) {
  return {
    agentId: 'jim',
    ptyId: 'pty-jim',
    lastOutputAt: TURN_END,
    inboxIds: ['mail-1'],
    oldestMailAt: MAIL_AT,
    lastActivityAt: TURN_END,
    hasTelemetry: true,
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

/** A worker whose hooks are live, mid-turn when its mail lands. */
function midTurnWorker() {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-jim', 0);
  w.noteHook('jim', 'Stop', undefined, T0);
  w.noteHook('jim', 'UserPromptSubmit', undefined, T0 + 1_000);
  return w;
}

/** The rest of the turn: tool calls every 5 s, then Stop. No prompt follows. */
function finishTurn(w) {
  for (let t = MAIL_AT + 1_000; t < TURN_END; t += 5_000) w.noteHook('jim', 'PreToolUse', undefined, t);
  w.noteHook('jim', 'Stop', undefined, TURN_END);
}

test('a wake typed into a busy CLI and never submitted is retyped once the turn ends', () => {
  const w = midTurnWorker();
  // The renderer read the seat as idle and typed the nudge; both writes succeeded.
  const claim = w.claimRendererInbox('jim', ['mail-1'], MAIL_AT + 100);
  assert.equal(claim.status, 'claimed');
  w.completeRendererInbox('jim', claim.token, true, MAIL_AT + 600);
  finishTurn(w);
  const later = TURN_END + WORKER_WAKE_IDLE_MS + 8_000;
  assert.deepEqual(w.decide([fact()], later), ['jim'],
    'the mail was never heard, so the quiet seat must be woken again');
});

test('the same sequence through the main beat is retyped too', () => {
  const w = midTurnWorker();
  const typedAt = MAIL_AT + WORKER_WAKE_IDLE_MS + 1;
  // A stalled reading at the time would let the beat type; force the beat path with a quiet PTY.
  assert.deepEqual(w.decide([fact({ lastOutputAt: typedAt - WORKER_WAKE_IDLE_MS - 1, lastActivityAt: 0, oldestMailAt: typedAt })], typedAt), ['jim']);
  w.submitted('jim', ['mail-1']);
  finishTurn(w);
  assert.deepEqual(w.decide([fact()], TURN_END + WORKER_WAKE_IDLE_MS + 8_000), ['jim']);
});

test('a wake answered by a UserPromptSubmit is announced and not retyped', () => {
  const w = midTurnWorker();
  const typedAt = TURN_END + WORKER_WAKE_IDLE_MS + 1;
  assert.deepEqual(w.decide([fact()], typedAt), ['jim']);
  w.submitted('jim', ['mail-1']);
  w.noteHook('jim', 'UserPromptSubmit', undefined, typedAt + 400);
  const later = typedAt + WORKER_WAKE_COOLDOWN_MS + ACK_MS + 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: later - WORKER_WAKE_IDLE_MS - 1 })], later), []);
  assert.equal(w.explain(fact({ lastOutputAt: later - WORKER_WAKE_IDLE_MS - 1 }), later), 'announced');
  assert.deepEqual(w.takeUnacked(), []);
});

test('a prompt that lands before the renderer confirms its writes still counts', () => {
  const w = midTurnWorker();
  const at = TURN_END + WORKER_WAKE_IDLE_MS + 1;
  const claim = w.claimRendererInbox('jim', ['mail-1'], at);
  w.noteHook('jim', 'UserPromptSubmit', undefined, at + 200);
  w.completeRendererInbox('jim', claim.token, true, at + 450);
  assert.equal(w.claimRendererInbox('jim', ['mail-1'], at + ACK_MS + 1).status, 'delivered');
});

test('an unanswered wake holds both paths for the ack window and a cooldown, then frees them', () => {
  const w = midTurnWorker();
  const at = TURN_END + WORKER_WAKE_IDLE_MS + 1;
  const claim = w.claimRendererInbox('jim', ['mail-1'], at);
  w.completeRendererInbox('jim', claim.token, true, at + 450);
  const quiet = (now) => fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1 });
  assert.equal(w.explain(quiet(at + 1_000), at + 1_000), 'awaiting-ack');
  assert.equal(w.claimRendererInbox('jim', ['mail-1'], at + 1_000).status, 'busy');
  const released = at + ACK_MS + 1;
  assert.deepEqual(w.decide([quiet(released)], released), []);
  assert.equal(w.claimRendererInbox('jim', ['mail-1'], released + 1).status, 'busy',
    'no typing onto the unanswered draft inside the cooldown');
  const free = at + ACK_MS + WORKER_WAKE_COOLDOWN_MS + 1;
  assert.equal(w.claimRendererInbox('jim', ['mail-1'], free).status, 'claimed');
});

test('a released wake is reported to the beat exactly once', () => {
  const w = midTurnWorker();
  const at = TURN_END + WORKER_WAKE_IDLE_MS + 1;
  assert.deepEqual(w.decide([fact()], at), ['jim']);
  w.submitted('jim', ['mail-1']);
  w.decide([fact()], at + ACK_MS + 1);
  assert.deepEqual(w.takeUnacked(), [{ agentId: 'jim', ids: ['mail-1'], typedAt: at }]);
  assert.deepEqual(w.takeUnacked(), []);
});

test('a worker with no hooks is announced on the write, as before (#368)', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-jim', 0);
  const at = TURN_END + WORKER_WAKE_IDLE_MS + 1;
  const quiet = (now) => fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1, hasTelemetry: false, lastActivityAt: 0 });
  assert.deepEqual(w.decide([quiet(at)], at), ['jim']);
  w.submitted('jim', ['mail-1']);
  const later = at + WORKER_WAKE_COOLDOWN_MS + ACK_MS + 1;
  assert.deepEqual(w.decide([quiet(later)], later), []);
  assert.deepEqual(w.takeUnacked(), []);
});
