const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

test('a descendant queue waiter protects an idle worker; an unrelated waiter does not', () => {
  const { descendantsOf, isQueueWait, parseProcessSnapshot } = loadTs('src/main/workerProcesses.ts');
  assert.deepEqual(parseProcessSnapshot('  102  101 Mon Oct 20 03:17:58 2026 bash /hive/bin/browser-run.sh --wait-for-lock=3600\n'),
    [{ pid: 102, ppid: 101, started: 'Mon Oct 20 03:17:58 2026', command: 'bash /hive/bin/browser-run.sh --wait-for-lock=3600' }]);
  assert.equal(parseProcessSnapshot('not a process'), null);
  const rows = [
    { pid: 101, ppid: 1, started: 'root', command: 'claude' },
    { pid: 102, ppid: 101, started: 'wait', command: 'bash /hive/bin/browser-run.sh --wait-for-lock=3600 -- node probe.mjs' },
    { pid: 103, ppid: 102, started: 'sleep', command: 'sleep 15' },
    { pid: 201, ppid: 1, started: 'other', command: 'bash /hive/bin/gate-launch.sh --wait-for-lock=3600' },
  ];
  assert.deepEqual(descendantsOf(rows, 101).map(r => r.pid), [102, 103]);
  assert.equal(isQueueWait(descendantsOf(rows, 101)), true);
  assert.equal(isQueueWait(descendantsOf(rows, 201)), false);
  assert.equal(isQueueWait([{ ...rows[1], command: 'echo browser-run.sh --wait-for-lock' }]), false);
});

test('reap releases only the old worker queue ticket', () => {
  const { releaseWorkerQueueTickets, workerQueueOwners } = loadTs('src/main/workerProcesses.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2184-queue-'));
  const dir = path.join(root, 'locks', 'gate-queue');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-20T05:00:00Z');
  const ticket = (name, agent, at) => fs.writeFileSync(path.join(dir, name), `pid=99999999\nagent=${agent}\nat=${at}\n`);
  try {
    ticket('old.ticket', 'worker-one', '2026-10-20T04:59:00Z');
    ticket('new.ticket', 'worker-one', '2026-10-20T05:01:00Z');
    ticket('other.ticket', 'worker-two', '2026-10-20T04:59:00Z');
    assert.deepEqual(workerQueueOwners(root, 'worker-one', now - 2 * 60_000,
      [{ pid: 99999999, ppid: 1, started: 'snapshot', command: 'bash browser-run.sh' }]).map(row => row.pid), [99999999]);
    assert.equal(releaseWorkerQueueTickets(root, 'worker-one', now), 1);
    assert.equal(fs.existsSync(path.join(dir, 'old.ticket')), false);
    assert.equal(fs.existsSync(path.join(dir, 'new.ticket')), true);
    assert.equal(fs.existsSync(path.join(dir, 'other.ticket')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom worker name finds its ticket and releases only its captured owner', () => {
  const { releaseWorkerQueueTickets, workerQueueOwners, workerTicketName } = loadTs('src/main/workerProcesses.ts');
  assert.equal(workerTicketName('worker-pam', 'Pam', { 'worker-pam': { name: 'Pam' } }), 'Pam');
  assert.equal(workerTicketName('worker-pam', 'Pam', {
    'worker-pam': { name: 'Pam' }, 'worker-other': { name: 'Pam' }
  }), 'worker-pam');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2423-queue-'));
  const dir = path.join(root, 'locks', 'gate-queue');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-20T05:00:00Z');
  const ticket = (name, pid, at) => fs.writeFileSync(path.join(dir, name), `pid=${pid}\nagent=Pam\nat=${at}\n`);
  try {
    ticket('mine.ticket', 99999999, '2026-10-20T04:59:00Z');
    ticket('same-name-other.ticket', 88888888, '2026-10-20T04:59:00Z');
    ticket('new.ticket', 99999999, '2026-10-20T05:01:00Z');
    const rows = [{ pid: 99999999, ppid: 1, started: 'snapshot', command: 'bash browser-run.sh' }];
    const owners = workerQueueOwners(root, 'worker-pam', now - 2 * 60_000, rows, 'Pam');
    assert.deepEqual(owners.map(row => row.pid), [99999999]);
    assert.equal(releaseWorkerQueueTickets(root, 'worker-pam', now, 'Pam', new Set(owners.map(row => row.pid))), 1);
    assert.equal(fs.existsSync(path.join(dir, 'mine.ticket')), false);
    assert.equal(fs.existsSync(path.join(dir, 'same-name-other.ticket')), true);
    assert.equal(fs.existsSync(path.join(dir, 'new.ticket')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captured children are terminated leaf first without touching unrelated processes', () => {
  const { descendantsOf, signalDescendants } = loadTs('src/main/workerProcesses.ts');
  const rows = [
    { pid: 101, ppid: 1, started: 'root', command: 'claude' },
    { pid: 102, ppid: 101, started: 'wait', command: 'bash /hive/bin/browser-run.sh --wait-for-lock' },
    { pid: 103, ppid: 102, started: 'sleep', command: 'sleep 15' },
    { pid: 201, ppid: 1, started: 'other', command: 'other' },
  ];
  const called = [];
  signalDescendants(descendantsOf(rows, 101), (pid, signal) => called.push([pid, signal]));
  assert.deepEqual(called, [[103, 'SIGTERM'], [102, 'SIGTERM']]);
});

test('worker scratch cleanup preserves tracked evidence and archives uncited scratch', () => {
  const { archiveWorkerScratchIfSafe } = loadTs('src/main/workerScratch.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2422-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    const tracked = path.join(root, 'agents', 'worker-one', 'wip', 'evidence.md');
    const untracked = path.join(root, 'agents', 'worker-two', 'scratch.txt');
    fs.mkdirSync(path.dirname(tracked), { recursive: true });
    fs.mkdirSync(path.dirname(untracked), { recursive: true });
    fs.writeFileSync(tracked, 'proof\n');
    fs.writeFileSync(untracked, 'temporary\n');
    assert.equal(spawnSync('git', ['-C', root, 'add', tracked]).status, 0);
    assert.equal(archiveWorkerScratchIfSafe(root, 'worker-one').result, 'tracked');
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'proof\n');
    const moved = archiveWorkerScratchIfSafe(root, 'worker-two');
    assert.equal(moved.result, 'archived');
    assert.equal(fs.existsSync(untracked), false);
    assert.equal(fs.readFileSync(path.join(moved.to, 'scratch.txt'), 'utf8'), 'temporary\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live worker tick respects spawn, hold and queue wait, then reaps descendants and its ticket', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const input = process.env.AEON2444_BREAK_WIRING === '1'
    ? source.replaceAll('if (!reapWorkerPty(workerId, rec.spawnedAt)) continue;',
      'if (false && !reapWorkerPty(workerId, rec.spawnedAt)) continue;')
    : source;
  if (process.env.AEON2444_BREAK_WIRING === '1') assert.notEqual(input, source, 'mutation reached live source');
  const ast = ts.createSourceFile('index.ts', input, ts.ScriptTarget.ES2022, true);
  const bodies = ['reapWorkerPty', 'ephemeralWorkerTick'].map(name => {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `live ${name} declaration exists`);
    return declaration.getText(ast);
  });
  const code = ts.transpileModule(`${bodies.join('\n')}\n({ ephemeralWorkerTick })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const { shouldReapIdleWorker } = loadTs('src/main/workerHold.ts');
  const { workerTicketName, workerQueueOwners, releaseWorkerQueueTickets, describeUnpushed, unpushedWorkerBranches } = loadTs('src/main/workerProcesses.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon2444-live-'));
  const workerId = 'worker-fixture';
  const now = Date.now();
  const spawnedAt = now - 120_000;
  const worker = { reqId: 'fixture', name: 'Fixture', spawnedAt, releasing: false };
  const liveWorkers = new Map();
  const rows = [{ pid: 99999999, ppid: 1, started: 'fixture', command: 'bash browser-run.sh --wait-for-lock=3600' }];
  const calls = { kill: [], signal: [], teardown: [], timers: [], notices: [] };
  let idleMs = 0;
  let waitState = 'other';
  const ticketDir = path.join(root, 'locks', 'gate-queue');
  const holdDir = path.join(root, 'agents', workerId);
  const requestDir = path.join(root, 'spawn-requests');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(holdDir, { recursive: true });
  fs.mkdirSync(requestDir);
  fs.writeFileSync(path.join(requestDir, 'fixture.json'), '{}');
  const ticket = (filename, agent, pid, at) => fs.writeFileSync(path.join(ticketDir, filename),
    `pid=${pid}\nagent=${agent}\nat=${new Date(at).toISOString()}\n`);
  ticket('old.ticket', 'Fixture', 99999999, now - 1000);
  ticket('new.ticket', 'Fixture', 99999999, now + 60_000);
  ticket('other.ticket', 'Other', 88888888, now - 1000);
  const context = {
    liveWorkers, workerTickRunning: false, preservedWorktrees: new Map(), lastGcSweepAt: now,
    GC_SWEEP_MS: 60_000, process, Date, Set, Math,
    console: { log() {}, warn() {}, error(error) { throw error; } },
    readConfig: () => ({ maxConcurrentWorkers: 4, workerIdleTimeoutMinutes: 1, orchestratorMaySpawn: true }),
    hive: { root: () => root, registry: () => ({ agents: { [workerId]: { name: 'Fixture' } } }),
      settleInbox: () => ({ moved: 0, kept: 0, unanswered: [] }) },
    ptyManager: { idleFor: () => idleMs, queueWaitState: () => waitState,
      kill: (id, children) => { calls.kill.push([id, children]); return { ok: true }; } },
    workerDoneAt: () => null, workerTokensUsed: () => 0,
    spawnRequestsDir: () => requestDir, existsSync: fs.existsSync, readdirSync: fs.readdirSync,
    join: path.join, processSpawnRequest: async file => {
      fs.unlinkSync(file);
      liveWorkers.set(workerId, worker);
    },
    shouldReapIdleWorker, workerTicketName,
    workerQueueOwners: (hiveRoot, id, at, _snapshot, name) => workerQueueOwners(hiveRoot, id, at, rows, name),
    releaseWorkerQueueTickets,
    signalDescendants: owners => calls.signal.push(...owners.map(owner => owner.pid)),
    forceRemainingDescendants: () => {},
    setTimeout: (fn, ms) => { calls.timers.push([ms, fn]); return { unref() {} }; },
    teardownPty: id => calls.teardown.push(id),
    informGod: (...args) => calls.notices.push(args),
    // AEON-2473: the reap notice lists unpushed branches; this worker has no worktrees.
    describeUnpushed, unpushedWorkerBranches, workerWorktreesRoot: () => path.join(root, 'worktrees'),
  };
  const { ephemeralWorkerTick } = vm.runInNewContext(code, context, { filename: 'live-worker-controller.js' });
  const check = (name, condition) => {
    if (!condition) console.error(`  ✗ ${name}`);
    assert.ok(condition, name);
  };
  try {
    await ephemeralWorkerTick();
    check('spawn request registers a fresh worker without reaping it', liveWorkers.get(workerId) === worker
      && calls.kill.length === 0 && worker.releasing === false);
    idleMs = 120_000;
    fs.writeFileSync(path.join(holdDir, 'parked.json'), JSON.stringify({ holder: workerId,
      reason: 'known gate wait', since: new Date(now - 30_000).toISOString(),
      expected_by: new Date(now + 60_000).toISOString() }));
    await ephemeralWorkerTick();
    check('current hold protects idle worker', calls.kill.length === 0 && worker.releasing === false);
    fs.unlinkSync(path.join(holdDir, 'parked.json'));
    waitState = 'waiting';
    await ephemeralWorkerTick();
    check('queue wait protects idle worker', calls.kill.length === 0 && worker.releasing === false);
    waitState = 'other';
    await ephemeralWorkerTick();
    check('idle path stops worker children and tears down exactly once',
      calls.kill.length === 1 && calls.kill[0][0] === workerId && calls.kill[0][1] === true
      && calls.teardown.length === 1 && calls.signal.includes(99999999) && worker.releasing);
    check('idle path schedules ticket release after descendant stop',
      calls.timers.some(([ms]) => ms === 5000) && calls.notices.length === 1);
    check('the reap notice says whether any branch is unpushed', /Every branch in its worktrees is on its remote/.test(calls.notices[0][1]));
    calls.timers.find(([ms]) => ms === 5000)[1]();
    check('reap releases only captured old ticket', !fs.existsSync(path.join(ticketDir, 'old.ticket'))
      && fs.existsSync(path.join(ticketDir, 'new.ticket')) && fs.existsSync(path.join(ticketDir, 'other.ticket')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
