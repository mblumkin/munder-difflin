'use strict';
/**
 * Every preset's recommendedOrchestratorModel must be a row in the baked catalog for its own
 * provider. Run with `node test/preset-default-in-catalog.test.cjs` (mirrors
 * test/agent-provider.test.cjs, which is also where the transpile harness below comes from).
 *
 * WHY THIS IS A CLASS AND NOT A TYPO. The recommended model is not advice -- it is the value
 * the UI PRESELECTS. Both consumers push it straight into a plain native <select>
 * (src/renderer/src/components/triggers/ui.tsx) whose <option> list is the catalog rows for
 * that provider:
 *   - CommandCenterPanel.tsx  setEngineModel(preset?.recommendedOrchestratorModel) on provider change
 *   - OnboardingWizard.tsx    seeds godModel with it on FIRST RUN, and resets it on provider change
 * A controlled select whose value matches no option does not display that value, so the user
 * sees one model and a different one gets spawned -- and on the onboarding path, the value the
 * user never saw is what finish() persists. Nothing else catches it: the id is a valid string,
 * the catalogs are valid JSON, typecheck is happy, and the two surfaces render without error.
 *
 * Two real instances existed when this test was written (AEON-1685), which is what makes it a
 * class rather than a one-off:
 *   claude -> 'claude-fable-5-1[1m]'  set as the default without adding the matching row
 *   codex  -> 'gpt-5-codex'           left behind when the list moved to GPT-6 / GPT-5.6
 *
 * An undefined recommendation is legitimate and skipped: it means "pass no --model flag" and
 * let the CLI choose, which grok, kimi, opencode, custom and now codex all rely on.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'presetcat-'));
for (const name of ['claudeCommands', 'codexCommands', 'grokCommands', 'agentProvider']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const { AGENT_PROVIDER_PRESETS } = require(path.join(out, 'agentProvider.js'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(SHARED, 'modelCatalog.json'), 'utf8'));

let failures = 0;
let checked = 0;
for (const preset of AGENT_PROVIDER_PRESETS) {
  const want = preset.recommendedOrchestratorModel;
  if (want === undefined) continue;
  checked++;
  const rows = CATALOG.providers[preset.id] || [];
  const ids = rows.map((m) => m.id).filter((id) => typeof id === 'string');
  if (ids.includes(want)) {
    console.log(`  ✓ ${preset.id}: ${want}`);
  } else {
    failures++;
    console.log(`  ✗ ${preset.id}: recommendedOrchestratorModel ${JSON.stringify(want)} is not a`
      + ` catalog row. The picker cannot display it. Rows: ${ids.join(', ') || '(none with an id)'}`);
  }
}

// A test that silently checks nothing passes forever. Every provider being `undefined` would
// make the loop above vacuous, so assert it actually examined something.
assert.ok(checked >= 5, `expected to check several presets, only checked ${checked}`);
console.log(`preset-default-in-catalog: ${checked} preset(s) with a recommendation, ${failures} bad`);
if (failures > 0) process.exit(1);
