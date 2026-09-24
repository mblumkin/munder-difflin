'use strict';

// AEON-1703: PROTOCOL.md and COMMANDS.md are read by every agent, whatever engine it runs
// on. They used to say every agent was Claude and that permission prompts arrive through
// Claude Code's /remote-control, which a Codex agent (approvals off, workspace sandbox)
// can never do. Assert on the files ensureHive() actually writes, not on the template.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-protocol-'));
const hive = new HiveManager(() => home);
hive.ensureHive();
const root = hive.root();
const protocol = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
const commands = fs.readFileSync(path.join(root, 'COMMANDS.md'), 'utf8');

test('PROTOCOL.md does not say every agent is Claude', () => {
  assert.doesNotMatch(protocol, /several Claude agents/);
  assert.match(protocol, /do not all run on the same\s+engine/);
});

test('PROTOCOL.md says what a never-prompting engine should do with a refused action', () => {
  assert.doesNotMatch(protocol, /Human-in-the-loop is native to Claude/);
  assert.match(protocol, /Other engines may never prompt at all/);
  assert.match(protocol, /refused or\s+sandbox-denied action is final/);
});

test('every Claude-only command in PROTOCOL.md is qualified where it appears', () => {
  for (const cmd of ['/remote-control', '/compact']) {
    let at = protocol.indexOf(cmd);
    assert.ok(at >= 0, `${cmd} is still documented for Claude agents`);
    while (at >= 0) {
      const around = protocol.slice(Math.max(0, at - 120), at + 120);
      assert.match(around, /on Claude Code/i, `${cmd} at offset ${at} is presented as universal`);
      at = protocol.indexOf(cmd, at + 1);
    }
  }
});

test('COMMANDS.md states it covers Claude Code only', () => {
  assert.match(commands.split('\n').slice(0, 4).join('\n'), /applies ONLY to an agent running on Claude Code/);
});
