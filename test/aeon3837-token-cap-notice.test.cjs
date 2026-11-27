'use strict';
// AEON-3837: a worker hears it is near its token cap, once at 85% and once at
// 95%, before the reap (11-27: worker-w38-hivetools was reaped at 20M with
// nothing in its inbox but its spawn order).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { tokenCapNoticeDue, tokenCapNoticeText } = loadTs('src/main/workerHold.ts');

test('driving a worker across 85% and 95% of its cap files exactly one notice each, before the reap', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-3837-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  const id = 'worker-w9003';
  await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });

  const cap = 20_000_000;
  const rec = {};
  const events = [];
  // The index.ts worker tick, one sample per step: notice first, then the reap check.
  for (const used of [1e6, 16e6, 16.9e6, 17e6, 17.5e6, 18.9e6, 19e6, 19.5e6, 20e6, 20.2e6]) {
    const pct = tokenCapNoticeDue(used, cap, rec.capNoticesSent ??= []);
    if (pct !== null) {
      hive.send({ to: id, act: 'inform', ...tokenCapNoticeText(pct, used, cap) }, 'ephemeral-worker');
      events.push(`notice ${pct} @${used}`);
    }
    if (used > cap) { events.push(`reap @${used}`); break; }
  }

  assert.deepEqual(events, ['notice 85 @17000000', 'notice 95 @19000000', 'reap @20200000']);
  const inbox = hive.inbox(id).filter((m) => /^Token cap/.test(m.subject));
  assert.deepEqual(inbox.map((m) => m.subject), ['Token cap 85%: write HANDOFF.md now', 'Token cap 95%: write HANDOFF.md now']);
  assert.match(inbox[0].body, /HANDOFF\.md[\s\S]*commit[\s\S]*inform god[\s\S]*stop/);
});

test('a jump past both thresholds sends one notice, and no cap sends none', () => {
  const sent = [];
  assert.equal(tokenCapNoticeDue(9.9e6, 10e6, sent), 95);
  assert.equal(tokenCapNoticeDue(9.95e6, 10e6, sent), null);
  assert.equal(tokenCapNoticeDue(5e6, 0, []), null);
});

test('the worker tick sends the notice before its token-cap reap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const notice = src.indexOf('tokenCapNoticeDue(used, tokenCap');
  const reap = src.indexOf('reaping ${workerId} — token cap');
  assert.ok(notice > 0 && reap > notice, 'the notice runs ahead of the reap in the same tick');
  assert.match(src.slice(notice, reap), /hive\.send\(\{ to: workerId, act: 'inform', \.\.\.tokenCapNoticeText/);
});
