'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('writeJson leaves a complete old or new target when an in-place write is interrupted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-atomic-hive-json-'));
  const target = path.join(dir, 'registry.json');
  const oldText = '{\n  "old": true\n}';
  const next = { agents: { pam: { cwd: '/tmp/pam' } } };
  const nextText = JSON.stringify(next, null, 2);
  fs.writeFileSync(target, oldText, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeFileSync = fs.writeFileSync;
  let attemptedInPlaceWrite = false;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file) === target) {
      attemptedInPlaceWrite = true;
      writeFileSync(target, '{\n  "partial":', 'utf8');
      throw new Error('planted interruption during in-place write');
    }
    return writeFileSync(file, ...args);
  });

  const hive = new HiveManager(() => dir);
  try {
    hive.writeJson(target, next);
  } catch (error) {
    // The base implementation hits the planted direct-write failure. The
    // atomic implementation never opens the target itself, so it succeeds.
    assert.match(String(error), /planted interruption/);
  }

  const actual = fs.readFileSync(target, 'utf8');
  assert.ok(
    actual === oldText || actual === nextText,
    `target must remain the complete old or new JSON document after interruption; got ${JSON.stringify(actual)}`
  );
  assert.equal(attemptedInPlaceWrite, false, 'writeJson must write a temporary file and rename it over the target');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith('registry.json.tmp-')),
    [],
    'a successful atomic replacement must leave no temporary file behind'
  );
});

test('atomicWriteJson removes a partial temporary file when its write fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-atomic-hive-temp-'));
  const target = path.join(dir, 'registry.json');
  const oldText = '{\n  "old": true\n}';
  fs.writeFileSync(target, oldText, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeFileSync = fs.writeFileSync;
  let planted = false;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(`${target}.tmp-`)) {
      planted = true;
      writeFileSync(file, '{\n  "partial":', 'utf8');
      throw new Error('planted interruption during temporary write');
    }
    return writeFileSync(file, ...args);
  });

  const hive = new HiveManager(() => dir);
  assert.throws(() => hive.writeJson(target, { agents: { pam: {} } }), /planted interruption/);
  assert.equal(planted, true, 'the test must interrupt the temporary-file write');
  assert.equal(fs.readFileSync(target, 'utf8'), oldText, 'a failed replacement must preserve the old target');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith('registry.json.tmp-')),
    [],
    'a failed temporary write must not leave a partial file behind'
  );
});
