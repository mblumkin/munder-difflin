const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { shouldReapIdleWorker } = loadTs('src/main/workerHold.ts');
const now = Date.parse('2026-10-13T12:00:00Z');
const spawnedAt = now - 26 * 60_000;
const workerId = 'worker-w2105b';
const idleMs = 25 * 60_000;
const timeoutMs = 20 * 60_000;
function fixture(record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2184-'));
  const dir = path.join(root, 'agents', workerId);
  fs.mkdirSync(dir, { recursive: true });
  if (record !== null) fs.writeFileSync(path.join(dir, 'parked.json'), JSON.stringify(record));
  return root;
}
function hold(overrides = {}) {
  return {
    holder: workerId, kind: 'park', reason: 'waiting for floor gate verdict',
    since: new Date(spawnedAt + 1000).toISOString(),
    expected_by: new Date(now + 10 * 60_000).toISOString(),
    ...overrides
  };
}
function withFixture(record, run) {
  const root = fixture(record);
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a worker silent for 25 minutes survives a current, bounded floor hold', () => {
  withFixture(hold(), root => assert.equal(
    shouldReapIdleWorker(root, workerId, spawnedAt, idleMs, timeoutMs, now), false));
});

test('the same silent worker without a hold is reaped', () => {
  withFixture(null, root => assert.equal(
    shouldReapIdleWorker(root, workerId, spawnedAt, idleMs, timeoutMs, now), true));
});

test('expired and previous-incarnation holds do not protect a dead worker', () => {
  withFixture(hold({ expected_by: new Date(now - 5 * 60_000).toISOString() }), root => assert.equal(
    shouldReapIdleWorker(root, workerId, spawnedAt, idleMs, timeoutMs, now), true));
  withFixture(hold({ since: new Date(spawnedAt - 60_000).toISOString() }), root => assert.equal(
    shouldReapIdleWorker(root, workerId, spawnedAt, idleMs, timeoutMs, now), true));
});

test('malformed marker does not suppress reaping', () => {
  withFixture({ holder: workerId, reason: 'hold', since: 'bad', expected_by: 'bad' }, root => assert.equal(
    shouldReapIdleWorker(root, workerId, spawnedAt, idleMs, timeoutMs, now), true));
});
