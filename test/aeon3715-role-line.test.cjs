'use strict';
// AEON-3715: an operator role edit (floor editor -> patchAgentRole) changes only
// the "- Role: " line of identity.md. A file with no Role line gets one inserted
// under its title; the rest of the authored file survives either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function seat(t, authored) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-aeon3715-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'a1', name: 'Pam', provider: 'claude', cwd: home, role: 'agent' });
  const idPath = path.join(home, 'hive', 'agents', 'a1', 'identity.md');
  if (authored !== undefined) fs.writeFileSync(idPath, authored);
  return { hive, read: () => fs.readFileSync(idPath, 'utf8') };
}

test('a Role-less authored identity.md gets the line under its title and keeps the rest', async (t) => {
  const { hive, read } = await seat(t, '# Pam (a1)\n\n- Workflow: one build and one verify in flight.\n- Project: /somewhere\n');
  assert.deepEqual(hive.patchAgentRole('a1', 'Hive platform lead'), { ok: true });
  assert.equal(read(), '# Pam (a1)\n\n- Role: Hive platform lead\n- Workflow: one build and one verify in flight.\n- Project: /somewhere\n');
});

test('a file with no title gets the Role line at the top', async (t) => {
  const { hive, read } = await seat(t, 'Rules: never push.\n');
  hive.patchAgentRole('a1', 'release engineer');
  assert.equal(read(), '- Role: release engineer\nRules: never push.\n');
});

test('an existing Role line is swapped in place, $ patterns literal', async (t) => {
  const { hive, read } = await seat(t, '# Pam (a1)\n\n- Role: old\n- Rules: keep me\n');
  hive.patchAgentRole('a1', 'costs $& and $1');
  assert.equal(read(), '# Pam (a1)\n\n- Role: costs $& and $1\n- Rules: keep me\n');
});

test('an empty identity.md is regenerated from the registry', async (t) => {
  const { hive, read } = await seat(t, '');
  hive.patchAgentRole('a1', 'writer');
  assert.match(read(), /^# Pam \(a1\)\n- Role: writer\n/);
});
