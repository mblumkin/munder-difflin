'use strict';

/**
 * AEON-2473: worker-w2443 was reaped as idle ("no output for 20 min, never signaled done") while it waited on its
 * own background command, and its report to god was never sent. A command a tool started produces no PTY output,
 * so output alone cannot tell waiting from idle. The reaper asks ptyManager.queueWaitState, which classifies the
 * worker's live descendants: any command a tool started counts as work, not only a browser-lock wait.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const procs = loadTs('src/main/workerProcesses.ts');

function busy(rows) {
  assert.equal(typeof procs.isToolCommand, 'function', 'no live-tool-command check: only a browser-lock wait keeps a silent worker');
  return procs.isToolCommand(rows);
}

const ROOT = { pid: 101, ppid: 1, started: 'root', command: '/Users/x/.local/bin/claude --model claude-opus-5-5' };
const child = (pid, command, ppid = 101) => ({ pid, ppid, started: String(pid), command });

test('a worker silent behind its own background command is busy (the w2443 shape)', () => {
  const rows = [ROOT,
    child(102, "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'git commit -F msg' < /dev/null"),
    child(103, 'git commit -F msg', 102), child(104, 'node tooling/git-hooks/pre-commit', 103)];
  assert.equal(busy(procs.descendantsOf(rows, 101)), true);
});

test('a Codex seat running a command is busy', () => {
  assert.equal(busy(procs.descendantsOf([{ ...ROOT, command: 'codex resume 01a0' }, child(102, "/bin/bash -lc 'npm test'")], 101)), true);
});

test('a browser-lock wait still counts', () => {
  assert.equal(busy(procs.descendantsOf([ROOT, child(102, 'bash /hive/bin/browser-run.sh --wait-for-lock=3600 -- node probe.mjs')], 101)), true);
});

test('a worker with no command in flight is not busy, so the idle reap still happens', () => {
  const rows = [ROOT, child(102, 'caffeinate -i -t 300'), child(103, 'node /Users/x/mcp/server.js --stdio'),
    child(201, "/bin/zsh -c 'sleep 600'", 1)];   // someone else's command, not under this worker
  assert.equal(busy(procs.descendantsOf(rows, 101)), false);
  assert.equal(busy([child(102, "echo '/bin/zsh -c x'")]), false, 'a command that only mentions a shell is not one');
});

test('a real background shell under this process is seen through the real process table', async (t) => {
  if (process.platform === 'win32') return t.skip('ps ancestry is POSIX only');
  const sh = spawn('/bin/sh', ['-c', 'sleep 30; true'], { stdio: 'ignore' });
  t.after(() => { try { sh.kill('SIGKILL'); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 200));
  const rows = procs.processSnapshot();
  assert.ok(rows, 'ps snapshot');
  assert.equal(busy(procs.descendantsOf(rows, process.pid)), true);
  sh.kill('SIGKILL');
  await new Promise((r) => sh.once('exit', r));
  assert.equal(busy(procs.descendantsOf(procs.processSnapshot(), process.pid)), false, 'once it exits the worker reads idle again');
});
