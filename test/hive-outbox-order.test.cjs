'use strict';

/**
 * AEON-2512: routeOnce delivers an agent's outbox in file-name order. Agents name outbox
 * files by timestamp, so name order is send order; readdirSync order is whatever the
 * filesystem returns. The fs stub hands the outbox back reversed to prove the sort is ours.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('routeOnce routes outbox files in name order whatever order readdir returns', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-order-'));
  const hive = new HiveManager(() => home);
  const realReaddir = fs.readdirSync;
  t.after(async () => {
    fs.readdirSync = realReaddir;
    await hive.flushGit();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });

  const outbox = path.join(home, 'hive', 'agents', 'worker-1', 'outbox');
  const names = ['2026-10-21T07-00-00-000Z-a.json', '2026-10-21T07-00-01-000Z-b.json', '2026-10-21T07-00-02-000Z-c.json'];
  for (const [i, name] of names.entries()) {
    fs.writeFileSync(path.join(outbox, name), JSON.stringify({ to: 'god', act: 'inform', subject: `m${i}`, body: 'x' }));
  }
  fs.readdirSync = function (dir, ...rest) {
    const out = realReaddir.call(fs, dir, ...rest);
    return path.resolve(String(dir)) === path.resolve(outbox) ? out.slice().sort().reverse() : out;
  };

  const seen = [];
  const route = hive.routeMessage.bind(hive);
  hive.routeMessage = (msg) => { seen.push(msg.subject); route(msg); };

  assert.equal(hive.routeOnce(), 3);
  assert.deepEqual(seen, ['m0', 'm1', 'm2']);
});
