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

// AEON-2096: the start folder above is deliberate, but the metadata named only the project, so
// a seat's registry and identity.md read as a mismatch with its live pwd. Both now record the
// start folder next to the project. The seat's tracked guide (agents/<id>/AGENTS.md) is also
// provisioned into its private CODEX_HOME, and a guide removed from the seat leaves no stale copy.
test('a Codex worker records where its session starts and carries its seat guide', async () => {
  const home = tmpHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-project-'));
  const hive = new HiveManager(() => home);
  const agentDir = path.join(home, 'hive', 'agents', 'pam-1');
  fs.mkdirSync(agentDir, { recursive: true });
  const guide = '# Pam\n\nKeep task artifacts under aeonNNNN/.\n';
  fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), guide);
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'codex', cwd: project }, {});
  assert.equal(inj.cwd, agentDir);
  const rec = hive.registry().agents['pam-1'];
  assert.equal(rec.cwd, project, 'the recorded cwd stays the project');
  assert.equal(rec.startDir, inj.cwd, 'the registry names the folder the session starts in');
  const identity = fs.readFileSync(path.join(agentDir, 'identity.md'), 'utf8');
  assert.ok(identity.includes(`- Project: ${project}`), identity);
  assert.ok(identity.includes(`- Session starts in: ${agentDir}`), identity);
  assert.ok(!identity.includes('- Working directory:'), 'no single label that only half applies');
  assert.equal(guideCopies(inj, guide), 1, 'the session reads its seat guide exactly once');

  fs.unlinkSync(path.join(agentDir, 'AGENTS.md'));
  const again = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'codex', cwd: project }, {});
  assert.ok(!fs.existsSync(path.join(again.env.CODEX_HOME, 'AGENTS.md')), 'a removed seat guide leaves no stale copy');
});

// Codex joins its instructions from CODEX_HOME/AGENTS.md and then every AGENTS.md from the git root (or the
// start folder alone, outside a repo) down to the start folder. A seat that starts in agents/<id>/ already
// finds its guide on that path, so a CODEX_HOME copy made it read the guide twice (seen on a live 0.5.17
// seat: two copies joined by "--- project-doc ---"). Counts the copies Codex would join for this spawn.
function guideCopies(inj, guide, startDir) {
  const start = startDir || inj.cwd;
  let top = start;
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { top = d; break; }
    if (path.dirname(d) === d) break;
  }
  const chain = [];
  for (let d = start; ; d = path.dirname(d)) { chain.push(d); if (d === top || path.dirname(d) === d) break; }
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  return [path.join(inj.env.CODEX_HOME, 'AGENTS.md'), ...chain.map((d) => path.join(d, 'AGENTS.md'))]
    .filter((f) => read(f) === guide).length;
}

test('a Codex seat in the hive repo reads its guide once; a Codex god starting in its project still gets it', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'hive', '.git'), { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-project-'));
  const hive = new HiveManager(() => home);
  const guide = '# Seat guide\n';
  for (const id of ['pam-1', 'god']) {
    const d = path.join(home, 'hive', 'agents', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'AGENTS.md'), guide);
  }
  const pam = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'codex', cwd: project }, {});
  assert.equal(guideCopies(pam, guide), 1, 'a seat starting in agents/<id>/ reads its guide once');
  const god = await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'codex', cwd: project, isGod: true }, {});
  assert.equal(god.cwd, undefined, 'the god starts in its project');
  assert.equal(guideCopies(god, guide, project), 1, 'a seat whose start folder cannot find its guide keeps the CODEX_HOME copy');
});

test('agents that start in their own cwd record no separate start folder', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'codex', cwd: home, isGod: true }, {});
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home }, {});
  for (const id of ['god', 'jim-1']) {
    assert.equal(hive.registry().agents[id].startDir, undefined, id);
    const identity = fs.readFileSync(path.join(home, 'hive', 'agents', id, 'identity.md'), 'utf8');
    assert.ok(identity.includes(`- Working directory: ${home}`), identity);
  }
});
