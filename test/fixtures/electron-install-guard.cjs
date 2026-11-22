'use strict';
// Preload for test/electron-opt-in.test.cjs, loaded before the trap: records and
// refuses any spawn of electron's install.js. Electron downloads its binary on the
// first require('electron') by spawning install.js, and that child reloads every
// NODE_OPTIONS preload, so an unguarded probe forks without bound (AEON-3713 v2).
const fs = require('node:fs');
const cp = require('node:child_process');
const guard = (orig) => function (cmd, args, ...rest) {
  if ([cmd, ...(Array.isArray(args) ? args : [])].some((a) => /install\.js$/.test(String(a)))) {
    fs.appendFileSync(process.env.ELECTRON_INSTALL_FILE, `${cmd} ${Array.isArray(args) ? args.join(' ') : ''}\n`);
    throw new Error('electron-install-guard: install.js spawn refused');
  }
  return orig.call(this, cmd, args, ...rest);
};
for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) cp[k] = guard(cp[k]);
