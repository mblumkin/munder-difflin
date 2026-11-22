'use strict';

/**
 * AEON-3709: a seat whose provider fails every turn can never send its
 * CLOSING-TIME-ACK, so god's CLOSING-TIME-COMPLETE was refused forever. The
 * refusal now names such a seat as unable to run, and a COMPLETE that names it
 * closes the app. A healthy straggler is still waited on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ClosingTimeController } = loadTs('src/main/closingTime.ts');

const FAIL = "model_not_found: The 'gpt-x' model is not supported";

function fixture(t, failing) {
  const sent = [];
  const phases = [];
  const sinceSeen = [];
  let concluded = 0;
  const hive = {
    registry: () => ({
      godId: 'god-1',
      agents: { 'god-1': { name: 'Michael', isGod: true }, 'w-ok': { name: 'Jim' }, 'w-broken': { name: 'Pam' } }
    }),
    send: (message) => sent.push(message)
  };
  const controller = new ClosingTimeController(
    hive,
    () => ['god-1', 'w-ok', 'w-broken'],
    () => ({ send: (_ch, ev) => phases.push(ev.phase) }),
    () => { concluded++; },
    undefined,
    undefined,
    (id, sinceMs) => { sinceSeen.push(sinceMs); return failing.includes(id) ? FAIL : null; }
  );
  // a refused or completed run still holds its 6-minute timer or teardown grace
  t.after(() => controller.cancel());
  const route = (from, subject, body = '') => controller.onRouted({ from, to: 'god-1', subject, body }, ['god-1']);
  return { controller, sent, phases, sinceSeen, route, concluded: () => concluded };
}

const refusals = (sent) => sent.filter((m) => m.act === 'refuse');

test('the refusal names a failing seat as unable to run, with its error', (t) => {
  const f = fixture(t, ['w-broken']);
  const before = Date.now();
  f.controller.start();
  f.route('w-ok', 'CLOSING-TIME-ACK');
  f.route('god-1', 'CLOSING-TIME-COMPLETE', 'all done');

  const [refusal] = refusals(f.sent);
  assert.ok(refusal, 'an unnamed failing seat is still refused');
  assert.match(refusal.body, /Pam \(w-broken\)/);
  assert.match(refusal.body, /model_not_found/);
  assert.match(refusal.body, /naming w-broken/);
  assert.ok(f.sinceSeen.every((t) => t >= before), 'only a turn after closing time began counts');
});

test('a COMPLETE naming the failing seat closes the app', (t) => {
  const f = fixture(t, ['w-broken']);
  f.controller.start();
  f.route('w-ok', 'CLOSING-TIME-ACK');
  f.route('god-1', 'CLOSING-TIME-COMPLETE', 'Pam excused: w-broken fails every turn (model_not_found)');

  assert.equal(refusals(f.sent).length, 0);
  assert.equal(f.phases.at(-1), 'complete');
});

test('naming a longer id that starts with the failing id does not excuse it', (t) => {
  const f = fixture(t, ['w-broken']);
  f.controller.start();
  f.route('w-ok', 'CLOSING-TIME-ACK');
  f.route('god-1', 'CLOSING-TIME-COMPLETE', 'excusing w-broken2 and w-broken-old only');

  assert.equal(refusals(f.sent).length, 1, 'w-broken2 is another seat; w-broken is not named');
  assert.notEqual(f.phases.at(-1), 'complete');
});

test('a whole id at the end of a sentence counts as named', (t) => {
  const f = fixture(t, ['w-broken']);
  f.controller.start();
  f.route('w-ok', 'CLOSING-TIME-ACK');
  f.route('god-1', 'CLOSING-TIME-COMPLETE', 'Nothing at risk for w-broken.');

  assert.equal(refusals(f.sent).length, 0);
  assert.equal(f.phases.at(-1), 'complete');
});

test('a healthy straggler is still waited on even when named', (t) => {
  const f = fixture(t, ['w-broken']);
  f.controller.start();
  f.route('god-1', 'CLOSING-TIME-COMPLETE', 'excusing w-ok and w-broken');

  const [refusal] = refusals(f.sent);
  assert.ok(refusal, 'w-ok has not acked and its turns do not fail');
  assert.match(refusal.body, /missing a CLOSING-TIME-ACK from: Jim \(w-ok\)/);
  assert.notEqual(f.phases.at(-1), 'complete');
});

test('codexLatestTurnFailure reads the latest turn of the seat thread', (t) => {
  const { codexLatestTurnFailure } = loadTs('src/main/providerTurn.ts');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-aeon3709-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.codex'));
  const db = new Database(path.join(dir, '.codex', 'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER)');
  const err = JSON.stringify({
    message: JSON.stringify({ type: 'error', status: 400, error: { message: "The 'gpt-x' model is not supported", code: 'model_not_found' } }),
    codexErrorInfo: 'other'
  });
  const add = db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)');
  add.run('th-1', 'a', 1, 'completed', null, 1000);
  add.run('th-1', 'b', 2, 'failed', err, 2000);
  add.run('th-2', 'c', 3, 'completed', null, 3000);
  db.close();

  assert.match(codexLatestTurnFailure(dir, 'th-1', 1_500_000), /model_not_found/);
  assert.equal(codexLatestTurnFailure(dir, 'th-1', 2_500_000), null, 'a failure before closing time does not count');
  assert.equal(codexLatestTurnFailure(dir, 'th-2', 0), null, 'a completed latest turn is healthy');
  assert.equal(codexLatestTurnFailure(path.join(dir, 'none'), 'th-1', 0), null, 'no database is no evidence');
});
