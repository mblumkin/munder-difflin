'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

test('appendCostLedger rotates before threshold and writes the next row to a fresh active file', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-writer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hiveRoot = path.join(home, 'hive');
  fs.mkdirSync(hiveRoot);
  const hive = new HiveManager(() => home, undefined, undefined, { rotateAtBytes: 200 });
  const sample = (usd) => ({
    agentId: 'agent-a', sessionId: 'session-a', ts: usd,
    input: 1, output: 2, cacheRead: 0, cacheCreation: 0, model: 'test', usd
  });

  hive.appendCostLedger(sample(1));
  const active = path.join(hiveRoot, 'cost-ledger.jsonl');
  const firstSize = fs.statSync(active).size;
  assert.ok(firstSize < 200, 'fixture row should fit under the threshold');

  hive.appendCostLedger(sample(2));
  hive.appendCostLedger(sample(3));
  const archives = fs.readdirSync(hiveRoot).filter((name) => /^cost-ledger\.\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name));
  assert.equal(archives.length, 2, 'same-day rotations should get unique archive names');
  for (const archive of archives) {
    assert.equal(fs.readFileSync(path.join(hiveRoot, archive), 'utf8').trim().split('\n').length, 1);
  }
  assert.equal(fs.readFileSync(active, 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(active, 'utf8')).usd, 3);
  const totals = new CostLedgerTotals();
  await totals.refreshFully(active);
  assert.equal(totals.usdFor('agent-a'), 3, 'archive rows plus active row must be folded exactly once');
});

test('fresh hives ignore both the active ledger and dated archive files', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-ignore-'));
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushGit();
    fs.rmSync(home, { recursive: true, force: true });
  });

  hive.ensureHive();
  const ignore = fs.readFileSync(path.join(home, 'hive', '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('cost-ledger*.jsonl'), 'archive glob must be installed on a fresh hive');
});
