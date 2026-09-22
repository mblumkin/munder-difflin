'use strict';
/**
 * priceFor tests — run with `node test/pricing-per-id.test.cjs` (mirrors test/transcript-usage.test.cjs).
 *
 * The family constants assume each generation prices like the last. Opus 5.5 is where that stopped
 * being true: it shipped BELOW the Opus family at $4/$20, and Fable never had a branch at all, so it
 * fell through to the Sonnet default at under a third of its real rate. Both are silent by nature —
 * the offline reconciler just reports a wrong dollar figure — so they are pinned here.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-'));
const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pricing.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
fs.writeFileSync(path.join(out, 'pricing.js'), js, 'utf8');
const { priceFor, estimateCostUsd } = require(path.join(out, 'pricing.js'));

// Anthropic's published table, 5-minute cache writes:
// https://platform.claude.com/docs/en/about-claude/pricing
assert.deepStrictEqual(priceFor('claude-opus-5-5'),
  { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 },
  'Opus 5.5 is priced per id, not by the Opus family');

assert.deepStrictEqual(priceFor('claude-opus-5-5[1m]'), priceFor('claude-opus-5-5'),
  'the 1M variant suffix resolves to the same id, as normalizeModel promises');

assert.deepStrictEqual(priceFor('CLAUDE-OPUS-5-5'), priceFor('claude-opus-5-5'),
  'id matching is case-insensitive, like the family matching below it');

assert.strictEqual(priceFor('claude-fable-5-1').inputPerM, 10,
  'Fable has its own branch; it used to fall through to the Sonnet default at $3');
assert.strictEqual(priceFor('claude-fable-5-1').outputPerM, 50);

// Controls: an id with no per-id row still resolves by family, and an unknown one still defaults.
assert.strictEqual(priceFor('claude-opus-4-8').inputPerM, 15, 'other Opus ids keep the family rate');
assert.strictEqual(priceFor('claude-sonnet-5').inputPerM, 3, 'Sonnet keeps the family rate');
assert.strictEqual(priceFor('some-unknown-model').inputPerM, 3, 'unknown ids still default to Sonnet');

// The per-id row has to reach the estimator, not just priceFor.
const cost = estimateCostUsd('claude-opus-5-5', {
  inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
});
assert.strictEqual(cost, 24, `1M in + 1M out on Opus 5.5 is $4 + $20, got ${cost}`);

fs.rmSync(out, { recursive: true, force: true });
console.log('pricing-per-id: all checks passed');
