'use strict';

/**
 * AEON-2451: a message an agent addresses to its own id was dropped. The router's
 * self-filter exists so god's mail to "human" (which resolves to god) does not loop
 * back, but it compared the RESOLVED target with the sender, so it also ate every
 * message an agent's own service sends to that agent by id. The hive's stall pager
 * runs as god and pages "god"; 110 pages were logged with delivered:[] and none
 * reached god's inbox. Only the alias case may be dropped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-self-to-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive };
}

const messages = (hive) => hive.logTail(500).filter((e) => e.kind === 'message');

// The stall pager's shape: a file in god's own outbox, addressed to "god", picked up by the router.
function queue(hive, from, envelope) {
  const outbox = path.join(hive.root(), 'agents', from, 'outbox');
  fs.writeFileSync(path.join(outbox, `${Date.now()}-${envelope.to}.json`), JSON.stringify(envelope));
  hive.routeOnce();
}

test('a page god queues to its own id lands in its inbox', async (t) => {
  const { hive } = await floor(t);
  queue(hive, 'god', { to: 'god', act: 'inform', subject: 'Stalled hive seat(s): jim-1', body: '1 new stalled hive seat(s)' });
  const inbox = hive.inbox('god');
  assert.equal(inbox.length, 1, 'the page must reach god');
  assert.equal(inbox[0].subject, 'Stalled hive seat(s): jim-1');
  assert.deepEqual(messages(hive).at(-1).delivered, ['god']);
});

test('any agent can mail its own id', async (t) => {
  const { hive } = await floor(t);
  queue(hive, 'jim-1', { to: 'jim-1', act: 'inform', subject: 'gate passed', body: 'green' });
  assert.equal(hive.inbox('jim-1').length, 1);
});

test('god mail to "human" still does not loop back to god', async (t) => {
  const { hive } = await floor(t);
  queue(hive, 'god', { to: 'human', act: 'inform', subject: 'CLOSING-TIME-COMPLETE', body: 'done' });
  assert.equal(hive.inbox('god').length, 0);
  assert.deepEqual(messages(hive).at(-1).delivered, []);
});
