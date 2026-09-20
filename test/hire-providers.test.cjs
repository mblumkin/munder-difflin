'use strict';
/**
 * AEON-1598: the hire manifest's provider whitelist was narrower than what the spawner supports,
 * so a gemini/opencode hire was rejected at validation. The list must equal PROVIDER_COMMAND's
 * keys (drift in either direction is a bug), keep 'custom' out, and leave the flag allowlist
 * provider-independent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { validateHireManifest, HIRE_PROVIDERS } = loadTs('src/shared/hire.ts');

const spawnerProviders = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'realtimeActions.ts'), 'utf8');
  const block = src.match(/const PROVIDER_COMMAND[^{]*\{([\s\S]*?)\};/)[1];
  return [...block.matchAll(/(\w+):\s*'/g)].map((m) => m[1]).sort();
})();

const manifest = (over = {}) => ({ spec: 'munder-difflin/hire@1', name: 'Zed', ...over });

test('the hire provider list equals the spawner\'s PROVIDER_COMMAND keys', () => {
  assert.deepEqual([...HIRE_PROVIDERS].sort(), spawnerProviders);
});

test('every supported provider validates; custom and unknown providers still reject', () => {
  for (const p of HIRE_PROVIDERS) {
    const r = validateHireManifest(manifest({ provider: p }));
    assert.equal(r.ok, true, p + ': ' + JSON.stringify(r.errors));
    assert.equal(r.manifest.provider, p);
  }
  assert.equal(validateHireManifest(manifest({ provider: 'agy' })).manifest.provider, 'antigravity');
  for (const bad of ['custom', 'grok', 'bash', '', 'GEMINI ']) {
    assert.equal(validateHireManifest(manifest({ provider: bad })).ok, false, JSON.stringify(bad));
  }
});

test('the flag allowlist stays default-deny for every provider, including the new ones', () => {
  for (const p of HIRE_PROVIDERS) {
    for (const flags of [['--model', 'x', '--max-turns', '3', '--verbose'], ['--output-format=json']]) {
      assert.equal(validateHireManifest(manifest({ provider: p, commandFlags: flags })).ok, true, p + ' ' + flags);
    }
    for (const flags of [['--yolo'], ['--approval-mode=yolo'], ['-c', 'x=y'], ['--dangerously-skip-permissions'], ['--base-url', 'http://evil'], ['--prompt', 'x']]) {
      assert.equal(validateHireManifest(manifest({ provider: p, commandFlags: flags })).ok, false, p + ' ' + flags);
    }
  }
});
