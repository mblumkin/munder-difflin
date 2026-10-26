'use strict';
// AEON-2586: every Claude model the app picks by default is a row in the Claude picker.
//
// The 4.x rows left the catalog while godModel and the role tiers still named 4.x ids. A
// default with no row is spawned without the picker being able to show it (the AEON-1685
// class), so the defaults are checked against the catalog rather than pinned as strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const catalog = require('../src/shared/modelCatalog.json');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-defaults-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, writeConfig, resetConfig, modelForRole } = loadTs('src/main/config.ts');
const { ASSISTANT_MODEL, agentModels, withCurrentModel } = loadTs('src/renderer/src/store/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const claudeIds = catalog.providers.claude.map((row) => row.id);

test('the default god, worker, helper, global and assistant models are Claude picker rows', () => {
  resetConfig();
  const cfg = readConfig();
  const defaults = {
    godModel: cfg.godModel,
    defaultModel: cfg.defaultModel,
    god: modelForRole({ isGod: true }, cfg),
    worker: modelForRole({ role: 'engineer' }),
    helper: modelForRole({ role: 'triage' }),
    assistant: ASSISTANT_MODEL
  };
  for (const [name, id] of Object.entries(defaults)) {
    assert.ok(claudeIds.includes(id), `${name} default ${id} has no row in the Claude picker`);
  }
});

test('the Claude picker offers no 4.x model', () => {
  assert.deepEqual(claudeIds.filter((id) => /^claude-(opus|sonnet|haiku)-4/.test(id ?? '')), []);
});

test('a saved 4.x god model is kept, not switched to the new default', () => {
  writeConfig({ godModel: 'claude-opus-4-8' });
  assert.equal(modelForRole({ isGod: true }, readConfig()), 'claude-opus-4-8');
});

test('a saved default model with no row gets a "(current)" chip; a known one adds nothing', () => {
  const known = agentModels();
  const shown = withCurrentModel(known, 'claude-opus-4-8', 'claude-opus-4-8 (current)');
  assert.deepEqual(shown.slice(0, known.length), known);
  assert.deepEqual(shown.at(-1), { id: 'claude-opus-4-8', label: 'claude-opus-4-8 (current)' });
  assert.equal(withCurrentModel(known, 'claude-fable-5', 'x'), known);
  assert.equal(withCurrentModel(known, undefined, 'x'), known);
});
