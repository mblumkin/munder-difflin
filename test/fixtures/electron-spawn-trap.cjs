'use strict';
// Preload for test/electron-opt-in.test.cjs: pretends to be Windows (so the
// win32-only Electron tests reach their launch) and turns any spawn of the
// Electron binary into a recorded refusal, so the probe itself never starts Electron.
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const tmp = os.tmpdir();
os.tmpdir = () => tmp; // win32 tmpdir() reads TEMP, unset on POSIX
Object.defineProperty(process, 'platform', { value: 'win32' });
let electronBin = '';
try { electronBin = require('electron'); } catch {}
const trap = (orig) => function (cmd, ...rest) {
  if (cmd === electronBin || /electron/i.test(String(cmd))) {
    fs.appendFileSync(process.env.ELECTRON_TRAP_FILE, `${cmd}\n`);
    throw new Error('electron-spawn-trap: Electron launch attempted');
  }
  return orig.call(this, cmd, ...rest);
};
cp.spawn = trap(cp.spawn);
cp.spawnSync = trap(cp.spawnSync);
cp.execFile = trap(cp.execFile);
cp.execFileSync = trap(cp.execFileSync);
