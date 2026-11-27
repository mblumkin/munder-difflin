'use strict';

/**
 * AEON-3670: an outbox message written by hand with a typed created_at minutes ahead of the clock was delivered
 * as-is; bin/drift-check.py only reported it afterwards (three on 2026-11-18, 122 to 188 s ahead). The router now
 * restamps a created_at more than 60 s past the file's write time to that write time, logs the original, and tells
 * the sender to use bin/send.sh. A message stamped by send.sh passes untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-future-stamp-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'dwight-1', name: 'Dwight', provider: 'claude', cwd: home });
  return { hive };
}

function queue(hive, from, name, envelope) {
  fs.writeFileSync(path.join(hive.root(), 'agents', from, 'outbox', `${name}.json`), JSON.stringify(envelope));
  hive.routeOnce();
}

test('a created_at 3 min ahead of the write is restamped, logged, and its sender told why', async (t) => {
  const { hive } = await floor(t);
  const typed = new Date(Date.now() + 180_000).toISOString();
  const before = Date.now();
  queue(hive, 'dwight-1', 'dwcard1', { id: 'dwcard1', to: 'god', act: 'inform', subject: 'card note', body: 'b', created_at: typed });

  const [got] = hive.inbox('god');
  assert.equal(got.subject, 'card note', 'the message itself must still be delivered');
  const stamped = Date.parse(got.created_at);
  assert.ok(stamped <= Date.now() && stamped >= before - 5_000, `delivered with created_at ${got.created_at}, typed ${typed}`);
  // drift-check's measure: the delivered file's created_at against its mtime, tolerance 60 s.
  const file = fs.readdirSync(path.join(hive.root(), 'agents', 'god', 'inbox')).find((f) => f.endsWith('.json'));
  const mtime = fs.statSync(path.join(hive.root(), 'agents', 'god', 'inbox', file)).mtimeMs;
  assert.ok(Math.abs(mtime - stamped) <= 60_000, 'drift-check would still report the delivered file');

  const log = hive.logTail(200).find((e) => e.kind === 'outbox-restamp');
  assert.ok(log, 'no outbox-restamp record in log.jsonl');
  assert.equal(log.from, 'dwight-1');
  assert.equal(log.created_at, typed);

  const notice = hive.inbox('dwight-1').find((m) => m.in_reply_to === 'dwcard1');
  assert.ok(notice, 'the sender was not told its created_at was rewritten');
  assert.match(notice.body, /send\.sh/);
});

test('a message stamped at write time passes untouched', async (t) => {
  const { hive } = await floor(t);
  const now = new Date().toISOString();
  queue(hive, 'dwight-1', 'ok1', { id: 'ok1', to: 'god', act: 'inform', subject: 'fine', body: 'b', created_at: now });
  assert.equal(hive.inbox('god')[0].created_at, now);
  assert.equal(hive.logTail(200).some((e) => e.kind === 'outbox-restamp'), false);
  assert.equal(hive.inbox('dwight-1').length, 0);
});

// AEON-3758: an unparseable created_at made the check above NaN > 60000, false, so it was delivered verbatim. It now takes
// the file's write time with the same record and notice as a future one.
async function routeWritten(t, extra) {
  const { hive } = await floor(t);
  const outFile = path.join(hive.root(), 'agents', 'dwight-1', 'outbox', 'bad1.json');
  fs.writeFileSync(outFile, JSON.stringify({ id: 'bad1', to: 'god', act: 'inform', subject: 'odd stamp', body: 'b', ...extra }));
  const written = new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000); // whole seconds: utimes rounds sub-ms
  fs.utimesSync(outFile, written, written);
  hive.routeOnce();
  const [got] = hive.inbox('god');
  assert.equal(got.subject, 'odd stamp', 'the message itself must still be delivered');
  assert.equal(got.created_at, written.toISOString());
  return { hive, written, log: hive.logTail(200).find((e) => e.kind === 'outbox-restamp') };
}

test("an unparseable created_at is restamped to the file's write time, logged, and its sender told why", async (t) => {
  const { hive, written, log } = await routeWritten(t, { created_at: 'not-a-date' });
  assert.ok(log, 'no outbox-restamp record in log.jsonl');
  assert.equal(log.created_at, 'not-a-date');
  assert.equal(log.restamped, written.toISOString());
  const notice = hive.inbox('dwight-1').find((m) => m.in_reply_to === 'bad1');
  assert.ok(notice, 'the sender was not told its created_at was rewritten');
  assert.match(notice.body, /an unreadable created_at "not-a-date"/);
  assert.match(notice.body, /send\.sh/);
});

// A missing one is how app-written envelopes look (stall pages, self mail), so it takes the write time silently: a
// record and notice there sent every page's sender a notice (god's self page landed twice, mail to human looped back).
test("a missing created_at takes the file's write time with no record and no notice", async (t) => {
  const { hive, log } = await routeWritten(t, {});
  assert.equal(log, undefined, 'a missing created_at must not log an outbox-restamp record');
  assert.equal(hive.inbox('dwight-1').length, 0, 'a missing created_at must not send its sender a notice');
});
