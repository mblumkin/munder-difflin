'use strict';
// AEON-3713: Electron started from a sandboxed seat SIGTRAPs within a second and
// macOS files a crash report on the user's desktop, so Electron-launching tests
// run only when MUNDER_ELECTRON_TESTS=1 (set it on an unsandboxed host).
module.exports = function requireElectronOptIn(name) {
  if (process.env.MUNDER_ELECTRON_TESTS === '1') return;
  console.log(`  SKIP  ${name} launches Electron; set MUNDER_ELECTRON_TESTS=1 on an unsandboxed host to run it`);
  process.exit(0);
};
