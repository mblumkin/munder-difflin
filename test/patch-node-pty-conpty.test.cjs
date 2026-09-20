'use strict';
/**
 * AEON-1610: the conpty patch script used to FAIL OPEN — every way of
 * not-patching exited 0, so a node-pty bump could silently stop applying a
 * guard against a whole-app Windows crash while postinstall still reported
 * success. These cases pin the decision logic, which is why it is a pure
 * function: the script's platform gate means nothing below Windows ever ran it,
 * and an untested fail-closed guard is the thing being fixed.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { planPatch, GUARDED_LIST, GUARDED_SEND } = require('../tools/patch-node-pty-conpty.cjs');

const ORIGINAL = [
  "var shellPid = process.argv[2];",
  "var consoleProcessList = getConsoleProcessList(shellPid);",
  "process.send({ consoleProcessList: consoleProcessList });",
].join('\n');

test('an unpatched source gets both guards', () => {
  const r = planPatch(ORIGINAL);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.applied.length, 2);
  assert.ok(r.out.includes(GUARDED_LIST));
  assert.ok(r.out.includes(GUARDED_SEND));
});

test('it is idempotent: re-running on its own output changes nothing', () => {
  const once = planPatch(ORIGINAL).out;
  const twice = planPatch(once);
  assert.strictEqual(twice.ok, true);
  assert.strictEqual(twice.applied.length, 0, 'nothing should be re-applied');
  assert.strictEqual(twice.already.length, 2);
  assert.strictEqual(twice.out, once, 'output must be byte-identical');
});

test('FAIL CLOSED: a source that is neither original nor patched is not ok', () => {
  // The exact shape a node-pty bump produces: the call is still there, spelled
  // differently. The old script exited 0 here, indistinguishably from success.
  const drifted = ORIGINAL.replace(
    'var consoleProcessList = getConsoleProcessList(shellPid);',
    'const consoleProcessList = getConsoleProcessList(Number(shellPid));'
  );
  const r = planPatch(drifted);
  assert.strictEqual(r.ok, false, 'drifted source must NOT report success');
  assert.deepStrictEqual(r.missing, ['getConsoleProcessList guard']);
});

test('FAIL CLOSED: each edit is judged independently, so a half-match still fails', () => {
  // Only the process.send line drifts. The old script applied the first edit,
  // saw out !== src, and reported success with half the guard missing.
  const halfDrifted = ORIGINAL.replace(
    'process.send({ consoleProcessList: consoleProcessList });',
    'process.send({ consoleProcessList });'
  );
  const r = planPatch(halfDrifted);
  assert.strictEqual(r.ok, false, 'a half-applicable patch must NOT report success');
  assert.deepStrictEqual(r.missing, ['process.send guard']);
  assert.deepStrictEqual(r.applied, ['getConsoleProcessList guard']);
});

test('a partially patched source completes rather than failing', () => {
  // Interrupted previous run: first guard in place, second not.
  const partial = ORIGINAL.replace('var consoleProcessList = getConsoleProcessList(shellPid);', GUARDED_LIST);
  const r = planPatch(partial);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.already, ['getConsoleProcessList guard']);
  assert.deepStrictEqual(r.applied, ['process.send guard']);
  assert.ok(r.out.includes(GUARDED_SEND));
});
