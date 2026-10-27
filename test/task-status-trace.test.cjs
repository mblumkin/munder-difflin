'use strict';

/**
 * AEON-2694: a status change made in the app (the task detail status select, voice
 * update_task, any hive:patchTask caller) must append, in the same write, a stamped
 * note ending in `[status: OLD -> NEW]`. The hive's bin/hooks/check-status-trace.py
 * refuses the next tasks.json commit otherwise. `traced` below is that hook's rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-status-trace-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  return hive;
}

function card(id, extra = {}) {
  return { id, title: id, status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-10-27T17:00:00Z', ...extra };
}

const get = (hive, id) => hive.tasks().tasks.find((c) => c.id === id);

function traced(old, now) {
  if (old.status === now.status) return true;
  const marker = `[status: ${old.status ?? 'None'} -> ${now.status}]`;
  const before = old.notes ?? [];
  const after = now.notes ?? [];
  return Array.isArray(after) && after.length > before.length &&
    JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before) &&
    typeof after.at(-1) === 'string' && after.at(-1).endsWith(marker);
}

test('a status change appends a stamped note ending in the exact marker', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('AEON-1', { notes: ['2026-10-27T17:00:00Z created'] })]);
  const old = structuredClone(get(hive, 'AEON-1'));
  assert.equal(hive.patchTask('AEON-1', { status: 'doing' }), true);
  const now = get(hive, 'AEON-1');
  assert.equal(now.status, 'doing');
  assert.ok(traced(old, now), JSON.stringify(now.notes));
  assert.equal(now.notes[0], '2026-10-27T17:00:00Z created');
  assert.match(now.notes[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /);
});

test('a card with no notes gets its first note on a status change', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('AEON-2', { status: 'blocked' })]);
  assert.equal(hive.patchTask('AEON-2', { status: 'done', result: 'shipped' }), true);
  const now = get(hive, 'AEON-2');
  assert.equal(now.notes.length, 1);
  assert.ok(now.notes[0].endsWith('[status: blocked -> done]'), now.notes[0]);
});

test('every status the app can set from every other one is traced', (t) => {
  const hive = floor(t);
  const all = ['todo', 'doing', 'blocked', 'done'];
  hive.writeTasks([card('AEON-3')]);
  for (const from of all) {
    for (const to of all) {
      hive.patchTask('AEON-3', { status: from });
      const old = structuredClone(get(hive, 'AEON-3'));
      hive.patchTask('AEON-3', { status: to });
      assert.ok(traced(old, get(hive, 'AEON-3')), `${from} -> ${to}`);
    }
  }
});

test('a patch that does not change the status adds no note', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('AEON-4', { status: 'doing', notes: ['n1'] })]);
  hive.patchTask('AEON-4', { assignee: 'jim' });
  hive.patchTask('AEON-4', { status: 'doing' });
  assert.deepEqual(get(hive, 'AEON-4').notes, ['n1']);
});

test('a hand-written notes field that is not a list is left alone', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('AEON-5', { notes: 'free text' })]);
  hive.patchTask('AEON-5', { status: 'done' });
  assert.equal(get(hive, 'AEON-5').notes, 'free text');
});
