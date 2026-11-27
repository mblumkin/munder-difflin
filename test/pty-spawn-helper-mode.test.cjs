'use strict';

/**
 * AEON-2686: `npm ci --ignore-scripts` skips the postinstall that runs tools/ensure-pty-perms.cjs, so node-pty's
 * spawn-helper can land at mode 644 and every pty test fails with a bare "posix_spawnp failed" that names nothing.
 * This precondition checks the helper node-pty actually loads in this runtime and names the fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the node-pty spawn-helper this runtime loads is executable', { skip: process.platform === 'win32' && 'conpty has no spawn-helper' }, () => {
  const ptyLib = path.dirname(require.resolve('node-pty/lib/utils.js'));
  const { dir } = require(path.join(ptyLib, 'utils.js')).loadNativeModule('pty');
  const helper = path.resolve(ptyLib, dir, 'spawn-helper');
  const mode = fs.statSync(helper).mode & 0o777;
  assert.equal(mode & 0o111, 0o111,
    `${helper} has mode ${mode.toString(8)}, so every pty spawn fails with "posix_spawnp failed". `
    + 'An install with --ignore-scripts skipped the postinstall; run: node tools/ensure-pty-perms.cjs');
});
