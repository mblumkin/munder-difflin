'use strict';

/**
 * AEON-3615: the spawn queue caps live workers at config maxConcurrentWorkers (default 4), but nothing in Settings
 * showed or set it, so a human looking for the cap found none, and the generated protocol never named it, so an
 * orchestrator read a cap wait as spawning switched off. Settings, Autonomy & Budgets now stages the key through the
 * one Save; config keeps it; PROTOCOL.md names the cap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worker-cap-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const MODAL = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');

test('Settings shows the worker cap from config and stages a 1-16 value under maxConcurrentWorkers', () => {
  const section = MODAL.slice(MODAL.indexOf("activeSection === 'Autonomy & Budgets'"));
  assert.match(section.slice(0, section.indexOf('Circuit breaker')), /min="1" max="16"[^>]*value=\{workerCap\}/,
    'no 1-16 worker cap input in Autonomy & Budgets');
  assert.match(MODAL, /useState<string>\(String\(cfgX\.maxConcurrentWorkers \?\? 4\)\)/, 'the input does not start at the config value');
  assert.match(MODAL, /n >= 1 && n <= 16\) stage\(\{ maxConcurrentWorkers: n \}/, 'the cap is not staged for the one Save');
});

test('a saved worker cap round-trips through config', () => {
  assert.equal(readConfig().maxConcurrentWorkers, 4, 'default changed');
  writeConfig({ maxConcurrentWorkers: 8 });
  assert.equal(readConfig().maxConcurrentWorkers, 8);
});

test('the generated protocol names the worker cap and says a request waits while that many run', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worker-cap-hive-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const protocol = fs.readFileSync(path.join(hive.root(), 'PROTOCOL.md'), 'utf8');
  assert.match(protocol, /maxConcurrentWorkers/);
  assert.match(protocol, /Workers at once/);
  assert.match(protocol, /waits in `spawn-requests\/`\s+even with spawning switched on/);
});
