'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md1849-'));
process.env.HOME = home;
const cwd = path.join(home, 'harness');
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const session = '11111111-1111-4111-8111-111111111111';
const transcript = path.join(dir, `${session}.jsonl`);
const hidden = loadTs('src/main/hiddenClaude.ts');

const assistant = (text, error) => JSON.stringify({
  type: 'assistant',
  ...(error ? { isApiErrorMessage: true, error } : {}),
  message: { content: [{ type: 'text', text }] },
}) + '\n';

test('last assistant API error returns a class, never successful text', () => {
  fs.writeFileSync(transcript,
    assistant('{"condensed":"older valid summary","hoist":[]}') +
    assistant('API Error: 401 — Login expired', 'authentication_failed'));
  assert.equal(hidden.extractLastAssistantText(cwd, session), null);
  assert.deepEqual(hidden.extractLastAssistantResult(cwd, session), {
    ok: false, error: 'api-error:authentication_failed',
  });
});

test('a later valid assistant response still has the existing text behavior', () => {
  const valid = '{"condensed":"new valid summary","hoist":[]}';
  fs.writeFileSync(transcript,
    assistant('API Error: 401 — Login expired', 'authentication_failed') + assistant(valid));
  assert.deepEqual(hidden.extractLastAssistantResult(cwd, session), { ok: true, text: valid });
  assert.equal(hidden.extractLastAssistantText(cwd, session), valid);
});

test('reflect records only the API error class in condense-abort', async () => {
  fs.writeFileSync(transcript, assistant('API Error: 401 — Login expired', 'authentication_failed'));
  const memory = path.join(cwd, 'hive', 'agents', 'fixture', 'memory.md');
  fs.mkdirSync(path.dirname(memory), { recursive: true });
  fs.writeFileSync(memory, '# Memory\n\n## Old\nOlder facts.\n\n## New\nNewer facts.\n');
  const original = hidden.runHiddenClaude;
  hidden.runHiddenClaude = async () => hidden.extractLastAssistantResult(cwd, session);
  try {
    const { MemoryReflector } = loadTs('src/main/reflect.ts');
    const events = [];
    const reflector = new MemoryReflector(
      () => cwd, () => 'claude', () => ({}),
      () => ({ enabled: true, intervalMs: 60_000, byteTriggerPct: 90,
        sectionTrigger: 1, recentKeep: 1, minBytes: 1 }),
      (event) => events.push(event),
    );
    await reflector.reflectNow('fixture');
    const abort = events.find((event) => event.kind === 'condense-abort');
    assert.equal(abort?.reason, 'summarize-failed');
    assert.match(abort?.detail || '', /api-error:authentication_failed/);
    assert.doesNotMatch(abort?.detail || '', /Login expired/);
  } finally {
    hidden.runHiddenClaude = original;
  }
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
