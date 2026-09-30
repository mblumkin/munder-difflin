'use strict';

/**
 * AEON-1848: a hidden session reads its OWN transcript. It used to take the newest .jsonl in the
 * project dir, and a live seat sharing that dir (god's cwd is the harness home) wrote there while
 * a condense settled: 2 of the 8 "no parseable JSON" condense aborts on 2026-09-29 read god's
 * prose instead of the condense reply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md1848-'));
process.env.HOME = home;
const cwd = path.join(home, 'harness');
fs.mkdirSync(cwd);
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });

const { extractLastAssistantText } = loadTs('src/main/hiddenClaude.ts');

const rec = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
const own = '11111111-1111-4111-8111-111111111111';
const seat = '22222222-2222-4222-8222-222222222222';

test('reads its own session file even when another session in the dir was written later', () => {
  fs.writeFileSync(path.join(dir, `${own}.jsonl`), rec('{"condensed":"ok","hoist":[]}'));
  const later = Date.now() / 1000 + 5;
  fs.writeFileSync(path.join(dir, `${seat}.jsonl`), rec('the live seat talking'));
  fs.utimesSync(path.join(dir, `${seat}.jsonl`), later, later);
  assert.equal(extractLastAssistantText(cwd, own), '{"condensed":"ok","hoist":[]}');
});

test('a missing own transcript is null, never a neighbour\'s text', () => {
  assert.equal(extractLastAssistantText(cwd, '33333333-3333-4333-8333-333333333333'), null);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
