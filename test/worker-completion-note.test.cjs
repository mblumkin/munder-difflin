'use strict';

/**
 * AEON-2476: every god-hired worker's objective ended "Do NOT push to any remote; god is the sole integrator", while
 * hive policy and god's dispatches require the feature branch pushed. worker-w2443 ended unpushed and was reaped
 * without a done message. The note now says to push the feature branch (never main, never a tag), then send done.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const index = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');

function note() {
  const { WORKER_COMPLETION_NOTE } = loadTs('src/main/workerLaunch.ts');
  assert.equal(typeof WORKER_COMPLETION_NOTE, 'string', 'no WORKER_COMPLETION_NOTE: the note is still inlined in index.ts');
  return WORKER_COMPLETION_NOTE;
}

test('the worker objective no longer forbids pushing', () => {
  assert.doesNotMatch(index, /Do NOT push to any remote/);
});

test('the note tells a worker to push its feature branch, and never main or a tag', () => {
  const n = note();
  assert.match(n, /push your feature branch/i);
  assert.match(n, /never push main or any tag/i);
  assert.doesNotMatch(n, /do not push/i);
});

test('the note still ends the job with one done message to god, naming the pushed branch', () => {
  const n = note();
  assert.match(n, /ONE outbox message to god with "act":"done"/);
  assert.match(n, /branch name and its pushed sha/);
  assert.ok(n.indexOf('push your feature branch') < n.indexOf('"act":"done"'), 'push comes before done');
});

test('the spawn path appends this note to the objective', () => {
  assert.match(index, /\$\{WORKER_COMPLETION_NOTE\}/);
});
