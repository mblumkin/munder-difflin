'use strict';

/**
 * god authors a spawn request's `command` as a full command LINE, but the PTY
 * layer takes one executable plus argv. The unsplit line made node-pty exec a
 * binary literally named `claude --model … --permission-mode …` → ENOENT → the
 * worker died in under a second WHILE its request archived as `.done`. A
 * failure that presents as success is exactly what a unit test is for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
const { tokenizeCommand } = loadTs('src/shared/commandLine.ts');

const launch = (over = {}) => buildWorkerLaunch({ autoMode: false, ...over });

test('a bare command spawns as itself, no argv', () => {
  const l = launch({ requestCommand: 'claude' });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, []);
});

test('a flag-carrying command line splits into executable + argv', () => {
  const l = launch({ requestCommand: 'claude --permission-mode plan --verbose' });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, ['--permission-mode', 'plan', '--verbose']);
});

test('a quoted model value with spaces stays one token', () => {
  const l = launch({ requestCommand: 'agy --model "Gemini 3.1 Pro (High)"' });
  assert.equal(l.bin, 'agy');
  assert.deepEqual(l.args, ['--model', 'Gemini 3.1 Pro (High)']);
});

test('the separate model field applies only when the line did not pick a model', () => {
  const applied = launch({ requestCommand: 'claude', requestModel: 'opus' });
  assert.deepEqual(applied.args, ['--model', 'opus']);
  const deduped = launch({ requestCommand: 'claude --model sonnet', requestModel: 'opus' });
  assert.deepEqual(deduped.args, ['--model', 'sonnet'], 'the command line wins over raw.model');
});

test('auto-mode ON appends bypassPermissions for a claude worker with no stance', () => {
  const l = launch({ requestCommand: 'claude', autoMode: true });
  assert.deepEqual(l.args, ['--permission-mode', 'bypassPermissions']);
  assert.ok(l.command.includes('--permission-mode bypassPermissions'));
});

test('an explicit --permission-mode in the request always wins over auto-mode', () => {
  const l = launch({ requestCommand: 'claude --permission-mode plan', autoMode: true });
  assert.deepEqual(l.args, ['--permission-mode', 'plan']);
});

test('auto-mode OFF appends nothing', () => {
  assert.deepEqual(launch({ requestCommand: 'claude', autoMode: false }).args, []);
  assert.deepEqual(launch({ requestCommand: 'codex', autoMode: false }).args, []);
});

test("auto-mode appends the PROVIDER'S flag, not claude's", () => {
  // A codex worker given --permission-mode would still stall at its first ask;
  // each provider's preset knows its own flag, same as the renderer's spawn path.
  const codex = launch({ requestCommand: 'codex', autoMode: true });
  assert.deepEqual(codex.args, ['-a', 'never', '-s', 'workspace-write']);
  const agy = launch({ requestCommand: 'agy', autoMode: true });
  assert.deepEqual(agy.args, ['--dangerously-skip-permissions']);
  const kimi = launch({ requestCommand: 'kimi', autoMode: true });
  assert.deepEqual(kimi.args, ['--auto']);
});

test('an explicit stance wins for non-claude providers too (no doubled flag)', () => {
  const l = launch({
    requestCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    autoMode: true
  });
  assert.deepEqual(l.args, ['--dangerously-bypass-approvals-and-sandbox']);
});

test('a provider whose preset declares no auto flag gets nothing appended', () => {
  assert.deepEqual(launch({ requestCommand: 'opencode', autoMode: true }).args, []);
  assert.deepEqual(launch({ requestCommand: 'my-own-tool', autoMode: true }).args, []);
});

test('a multi-token auto flag appends whole, and the stance check is by token', () => {
  // copilot's flag starts with `-s`; a substring check would read the `-s` inside
  // --summarize as an explicit stance and skip the append.
  const l = launch({ requestCommand: 'copilot --summarize', autoMode: true });
  assert.deepEqual(l.args, ['--summarize', '-s', '--allow-all-tools', '--no-ask-user']);
});

test("an explicit request provider picks that provider's flag for a custom binary", () => {
  const l = launch({ requestCommand: 'my-codex-wrapper', requestProvider: 'codex', autoMode: true });
  assert.deepEqual(l.args, ['-a', 'never', '-s', 'workspace-write']);
});

test('a missing command falls back to the default, then to claude', () => {
  assert.equal(launch({ defaultCommand: 'codex --full-auto' }).bin, 'codex');
  assert.equal(launch({}).bin, 'claude');
});

test('main and renderer split with the SAME tokenizer (shared module)', () => {
  // The old inline copy was byte-identical to the renderer's; now it IS the
  // renderer's. One example locks the routing through the shared function.
  assert.deepEqual(tokenizeCommand(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
});

// AEON-1597: a request naming a provider but no command launched cfg.defaultCommand (claude) with
// the provider's flags; claude rejected --approval-mode / --prompt and the smoke workers crashed.
test('AEON-1597: a provider with no command launches that provider\'s own CLI, not the app default', () => {
  const l = launch({ requestProvider: 'gemini', defaultCommand: 'claude', autoMode: true });
  assert.equal(l.bin, 'gemini');
  assert.match(l.command, /--approval-mode/);
  const o = launch({ requestProvider: 'opencode', defaultCommand: 'claude' });
  assert.equal(o.bin, 'opencode');
});

test('AEON-1597: every provider preset resolves to its own binary when no command is given', () => {
  const { AGENT_PROVIDERS, defaultCommandForProvider } = loadTs('src/shared/agentProvider.ts');
  const providers = (AGENT_PROVIDERS || ['claude', 'codex', 'gemini', 'opencode', 'crush', 'pi', 'qwen', 'copilot', 'cursor', 'antigravity']);
  for (const p of providers) {
    const want = defaultCommandForProvider(p);
    if (!want) continue;
    assert.equal(launch({ requestProvider: p, defaultCommand: 'somethingelse' }).bin, want, p);
  }
});

test('AEON-1597: an explicit command still wins over the provider default', () => {
  assert.equal(launch({ requestProvider: 'gemini', requestCommand: 'mygemini --x', defaultCommand: 'claude' }).bin, 'mygemini');
});

test('AEON-1597: no provider and no command still falls back to the app default; unknown provider too', () => {
  assert.equal(launch({ defaultCommand: 'claude' }).bin, 'claude');
  assert.equal(launch({ requestProvider: 'not-a-provider', defaultCommand: 'claude' }).bin, 'claude');
});
