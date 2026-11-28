'use strict';

/**
 * AEON-3842: the model rows upstream added on 2026-11-10, 11-14 and 11-18 (a0caf4415,
 * 34cc86c6b, 5759226e9) are in both catalogs, in AEON-2586's shape.
 *
 * The remote catalog (docs/model-catalog.json, fetched from the fork's main) and the
 * built-in fallback (src/shared/modelCatalog.json) must carry the same providers, or an
 * app that cannot reach the remote list offers a different picker. AEON-2586 dropped the
 * Claude 4.x rows from the Claude picker, so the port adds none of them back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const load = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).providers;
const remote = load('docs/model-catalog.json');
const builtIn = load('src/shared/modelCatalog.json');
const ids = (cat, p) => (cat[p] || []).map((r) => r.id);

test('the remote and built-in catalogs carry the same providers and rows', () => {
  assert.deepEqual(builtIn, remote);
});

test("upstream's November rows are offered", () => {
  const want = {
    claude: ['claude-fable-5-2'],
    codex: ['gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol'],
    grok: ['grok-4.7', 'grok-4.7-build-fast'],
    kimi: ['kimi-code/k3.1-pro', 'kimi-code/k3.1-pro-highspeed'],
    qwen: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3-coder-next'],
    opencode: ['anthropic/claude-fable-5-2', 'openai/gpt-6.2-sol', 'xai/grok-4.7'],
    copilot: ['claude-fable-5.2', 'gpt-6.2-sol', 'grok-4.7']
  };
  for (const cat of [remote, builtIn]) {
    for (const [p, list] of Object.entries(want)) {
      for (const id of list) assert.ok(ids(cat, p).includes(id), `${p} offers ${id}`);
    }
  }
});

test('the port adds no Claude 4.x row and no duplicate', () => {
  for (const id of ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-4-6']) {
    assert.ok(!ids(remote, 'opencode').includes(id), `opencode has no ${id}`);
  }
  assert.ok(!ids(remote, 'copilot').includes('claude-opus-4.8'));
  assert.deepEqual(ids(remote, 'claude').filter((id) => /claude-(opus|sonnet|haiku)-4/.test(id)), []);
  for (const p of Object.keys(remote)) {
    const list = ids(remote, p);
    assert.equal(new Set(list).size, list.length, `${p} has no duplicate id`);
  }
});
