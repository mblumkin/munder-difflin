'use strict';

/**
 * AEON-3708: every spawn (so every app start) rewrote agents/<id>/identity.md
 * from the registry, replacing an agent-authored role with "a fresh harness" or
 * "agent". An existing identity.md belongs to the agent; the harness only creates
 * a missing one, and an operator role edit swaps the Role line alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// AEON-3715: codex agents resolve the user's Codex home via os.homedir(); keep it off the real ~/.codex.
const realHome = process.env.HOME;
const realProfile = process.env.USERPROFILE;
process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'md-aeon3708-home-'));
assert.equal(os.homedir(), process.env.HOME, 'home redirect failed; aborting before touching the real home');
test.after(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
});

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-aeon3708-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive, idPath: (id) => path.join(home, 'hive', 'agents', id, 'identity.md') };
}

const AUTHORED = [
  '# Pam (a1)',
  '- Role: platform engineer for Hive tooling patches',
  '- Workflow: at most one build and one verify in flight.',
  '- Project: /somewhere',
  ''
].join('\n');

test('a respawn leaves an authored identity.md byte-identical', async (t) => {
  const { home, hive, idPath } = setup(t);
  // first hire: registry gets the placeholder role the floor sends
  await hive.ensureAgent({ id: 'a1', name: 'Pam', provider: 'codex', cwd: home, role: 'a fresh harness' });
  fs.writeFileSync(idPath('a1'), AUTHORED, 'utf8');

  // app restart: the roster passes the same placeholder again
  await hive.ensureAgent({ id: 'a1', name: 'Pam', provider: 'codex', cwd: home, role: 'a fresh harness' });

  assert.equal(fs.readFileSync(idPath('a1'), 'utf8'), AUTHORED);
});

test('a seat with no identity.md still gets one, ending in a newline', async (t) => {
  const { home, hive, idPath } = setup(t);
  await hive.ensureAgent({ id: 'a2', name: 'Jim', provider: 'claude', cwd: home, role: 'release engineer' });

  const text = fs.readFileSync(idPath('a2'), 'utf8');
  assert.match(text, /^# Jim \(a2\)\n/);
  assert.match(text, /^- Role: release engineer$/m);
  assert.ok(text.endsWith('\n'), 'a generated file ends with a newline');
});

test('an operator role edit changes the Role line and keeps the rest', async (t) => {
  const { home, hive, idPath } = setup(t);
  await hive.ensureAgent({ id: 'a1', name: 'Pam', provider: 'codex', cwd: home });
  fs.writeFileSync(idPath('a1'), AUTHORED, 'utf8');

  assert.deepEqual(hive.patchAgentRole('a1', 'Hive platform lead'), { ok: true });

  assert.equal(fs.readFileSync(idPath('a1'), 'utf8'),
    AUTHORED.replace('- Role: platform engineer for Hive tooling patches', '- Role: Hive platform lead'));
});
