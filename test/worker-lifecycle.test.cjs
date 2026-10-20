const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('worker scratch cleanup preserves tracked evidence and removes only uncited scratch', () => {
  const { removeWorkerScratchIfSafe } = loadTs('src/main/workerScratch.ts');
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
    assert.equal(removeWorkerScratchIfSafe(root, 'worker-one'), 'tracked');
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'proof\n');
    assert.equal(removeWorkerScratchIfSafe(root, 'worker-two'), 'removed');
    assert.equal(fs.existsSync(untracked), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live paths call queue-wait detection, full child stop and tracked scratch guard', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const pty = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(source, /queueWaitState\(workerId\)/);
  assert.match(source, /kill\(workerId, true\)/);
  assert.match(source, /removeWorkerScratchIfSafe\(root, workerId\)/);
  assert.match(pty, /signalDescendants\(/);
});
