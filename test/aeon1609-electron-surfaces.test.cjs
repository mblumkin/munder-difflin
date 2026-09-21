'use strict';
/**
 * AEON-1609: the Electron-runtime harness AEON-1607 needs.
 *
 * WHY IT EXISTS: before this, `npm run test:focused` was 119 files running in
 * plain Node, and the one Electron-booting test (quit-sweep.electron) returns
 * at its first line on anything but Windows. So on this macOS floor nothing
 * booted the app at all, and every security surface the Electron 32 -> 44 jump
 * moves — renderer isolation, permission handlers, window-open, powerMonitor,
 * clipboard, shell.openPath — was verified only by a human using the app. A
 * green suite said nothing about the thing being changed.
 *
 * DISCIPLINE: this must pass on the CURRENT Electron (32.3.3) before the jump.
 * A harness written against 44 that has never passed on 32 cannot tell
 * "44 broke it" from "my harness is wrong".
 *
 * Self-contained, no framework — `node test/aeon1609-electron-surfaces.test.cjs`.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let failures = 0;
const check = (desc, cond, hint) => {
  if (cond) { console.log(`  ok    ${desc}`); return; }
  failures++;
  console.log(`  FAIL  ${desc}${hint ? ` — ${hint}` : ''}`);
};

// The electron package exports the path to the binary when required from plain
// Node. An `npm ci --ignore-scripts` leaves that binary undownloaded while the
// require still resolves, so assert the FILE before blaming the harness for
// anything downstream (recovery: node node_modules/electron/install.js).
const electronBin = require('electron');
assert.strictEqual(typeof electronBin, 'string', 'electron package should export the binary path');
if (!fs.existsSync(electronBin)) {
  console.log(`  FAIL  the Electron binary is not installed at ${electronBin}`);
  console.log('        run: node node_modules/electron/install.js   (npm ci --ignore-scripts skips it)');
  process.exit(1);
}
check('the Electron binary exists and is executable', (fs.statSync(electronBin).mode & 0o111) !== 0, electronBin);

const fixture = path.join(__dirname, 'fixtures', 'aeon1609-surface-probe.cjs');
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon1609-')), 'probe.json');

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // must launch AS Electron, not as Node

  const child = spawn(electronBin, [fixture, `--out=${outFile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });

  const exit = await new Promise((resolve) => {
    // Bound from the outside too: a hung Electron is the failure mode that
    // masquerades as a slow one, and a duration equal to a timeout is not a
    // measurement.
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve('TIMEOUT'); }, 60000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });

  check('the fixture exited cleanly (no hang, no crash)', exit === 0, `exit=${exit}${stderr ? ` stderr=${stderr.slice(0, 400)}` : ''}`);
  if (exit !== 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }

  const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  check('the fixture reported no fatal error', res.fatal === null, String(res.fatal));

  // Recording the real runtime versions is half the point: this is the
  // before/after evidence for the 32 -> 44 jump, not decoration.
  console.log(`  ⓘ  electron=${res.versions.electron} chrome=${res.versions.chrome} node=${res.versions.node}`);

  const probe = (name) => res.probes[name] || { ok: false, error: 'probe missing from fixture output' };
  const expect = [
    ['appReady', 'the app reaches whenReady'],
    ['singleInstanceLock', 'the single-instance lock is acquired (second-instance IPC path)'],
    ['rendererLoads', 'a BrowserWindow with the app\'s real isolation settings loads a page'],
    ['secureContext', 'the probe document is a secure context (permission requests reach the handler)'],
    ['rendererIsolated', 'contextIsolation holds: no require/process/module in the renderer'],
    ['windowOpenHandlerFired', 'setWindowOpenHandler receives the window.open target'],
    ['permissionRequestHandlerFired', 'setPermissionRequestHandler receives a real renderer request'],
    ['permissionCheckHandlerFired', 'setPermissionCheckHandler is consulted'],
    ['permissionHandlersInstalled', 'both permission handlers install'],
    ['powerMonitorReadable', 'powerMonitor answers (UAF advisory surface)'],
    ['clipboardReadText', 'clipboard.readText resolves a string (async since Electron 44)'],
    ['clipboardImageSurface', 'clipboard.has + clipboard.read answer (the API that replaced readImage; malformed-image crash advisory)'],
    ['shellOpenPathRejectsMissing', 'shell.openPath reports an error for a missing path, opening nothing'],
    ['isDefaultProtocolClient', 'the deep-link scheme registration is readable'],
    ['getLoginItemSettings', 'login-item settings are readable'],
    ['nativeSqlite', 'better-sqlite3 loads under the Electron ABI and round-trips a row'],
    ['nativePty', 'node-pty loads under the Electron ABI and a real pty produces output'],
  ];
  for (const [name, desc] of expect) {
    const p = probe(name);
    check(desc, p.ok === true, p.error || JSON.stringify(p.value));
  }

  for (const [name, why] of Object.entries(res.skips)) console.log(`  skip  ${name} — ${why}`);

  console.log(`\n${failures === 0 ? `all ${expect.length + 3} checks passed` : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
