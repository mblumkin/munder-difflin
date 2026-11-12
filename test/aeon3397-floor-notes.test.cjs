'use strict';

// AEON-3397 (Mason's option 1): on the office floor's task board a ready card hangs on the To Do
// corkboard in Ready's lane color, and Backlog stays off the floor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const { taskBoardNotes } = loadTs('src/renderer/src/scene/office/taskBoardNotes.ts');

test('one card per status lands where the floor draws it', () => {
  const statuses = ['backlog', 'todo', 'doing', 'blocked', 'ready', 'done', 'cancelled'];
  const notes = taskBoardNotes(statuses.map((status) => ({ status, assignee: `worker-${status}` })));
  assert.deepEqual(notes.blocked, ['blocked'], 'the left corkboard holds the blocked card');
  assert.deepEqual(notes.todo, ['todo', 'ready'], 'the To Do corkboard holds the todo card and a ready note');
  assert.deepEqual(notes.doing.map((t) => t.status), ['doing'], 'only the doing card goes to a desk');
  assert.equal(notes.done, 1, 'the archive table counts the done card');
});

test('a ready note uses the Ready lane color, and the floor draws through taskBoardNotes', () => {
  const lane = source('src/renderer/src/components/TasksKanban.tsx').match(/key: 'ready',[^}]*accent: 'var\(--(cth-[a-z]+)\)'/);
  assert.ok(lane, 'the Ready lane names a --cth- accent');
  const hex = source('src/renderer/src/design/tokens.css').match(new RegExp(`--${lane[1]}:\\s*#([0-9a-f]{6})`, 'i'));
  const note = source('src/renderer/src/scene/office/themeRegistry.ts').match(/noteColors:\s*\{[^}]*\bready:\s*0x([0-9a-f]{6})/i);
  assert.ok(hex && note, 'the Ready accent and a ready note color both exist');
  assert.equal(note[1].toLowerCase(), hex[1].toLowerCase(), `the ready note is the Ready lane's --${lane[1]}`);
  assert.match(source('src/renderer/src/scene/office/OfficeFloor.tsx'), /=\s*taskBoardNotes\(tasks\)/);
});
