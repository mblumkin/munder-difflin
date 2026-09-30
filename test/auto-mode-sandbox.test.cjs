/**
 * Auto mode keeps the OS sandbox ON.
 *
 * The app used to spawn every auto-mode agent with no sandbox at all (codex
 * `--dangerously-bypass-approvals-and-sandbox`; Claude with its opt-in sandbox
 * never enabled) for one reason: a hive worker writes to its agent folder under
 * <harnessHome>/hive/agents/<id>/, which sits OUTSIDE the project cwd. That is a
 * path-layout problem. Fix: keep the sandbox and declare those paths writable —
 * codex via `--add-dir`, Claude via `sandbox.filesystem.allowWrite` plus
 * `permissions.additionalDirectories` in the per-session settings file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { autoModeFlagForProvider } = loadTs('src/shared/agentProvider.ts');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-sandbox-')); }

test('codex auto mode is workspace-write with approvals off, never the full bypass', () => {
  const flag = autoModeFlagForProvider('codex');
  assert.equal(flag, '-a never -s workspace-write');
  assert.ok(!flag.includes('dangerously'));
});

test('a Claude agent gets a native sandbox that still allows its agent dir and the hive root', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  const palace = path.join(home, 'palace');
  const inj = await hive.ensureAgent(
    { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home },
    { extraWritableDirs: [palace] }
  );
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, 'claude spawn carries --settings');
  const settings = JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8'));
  const agentDir = path.join(home, 'hive', 'agents', 'jim-1');
  const hiveRoot = path.join(home, 'hive');
  assert.equal(settings.sandbox.enabled, true);
  assert.notEqual(settings.sandbox.failIfUnavailable, true, 'Windows must still spawn');
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [agentDir, hiveRoot, palace]);
  // Both layers, or the agent deadlocks: Edit/Write allowed but `mv … .done/` denied.
  assert.deepEqual(settings.permissions.additionalDirectories, settings.sandbox.filesystem.allowWrite);
  // No bypass of the sandbox anywhere in the injected args.
  assert.ok(!inj.args.some((a) => /dangerously/.test(a)));
});

// AEON-1820: a Codex worker's session started in its project (for one seat the reactor primary,
// read-only to it), so every relative path it typed was judged there. It now starts in its agent
// folder, and the project stays writable as an extra root. The recorded cwd is not rewritten.
test('a Codex worker starts in its agent folder and keeps its project writable', async () => {
  const home = tmpHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-project-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'codex', cwd: project }, {});
  const agentDir = path.join(home, 'hive', 'agents', 'pam-1');
  assert.equal(inj.cwd, agentDir);
  assert.ok(fs.statSync(agentDir).isDirectory(), 'the start folder exists before the PTY spawns');
  const added = inj.args.flatMap((a, i) => (a === '--add-dir' ? [inj.args[i + 1]] : []));
  assert.ok(added.includes(project), `project is a writable root: ${JSON.stringify(added)}`);
  assert.ok(added.includes(agentDir) && added.includes(path.join(home, 'hive')));
  assert.equal(hive.registry().agents['pam-1'].cwd, project, 'the recorded cwd stays the project');
});

test('a Codex god and a Claude worker keep starting in their own cwd', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  const god = await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'codex', cwd: home, isGod: true }, {});
  assert.equal(god.cwd, undefined);
  const jim = await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home }, {});
  assert.equal(jim.cwd, undefined);
});
