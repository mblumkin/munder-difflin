'use strict';
/**
 * AEON-1609 fixture: runs as an Electron MAIN process and probes the security
 * surfaces the AEON-1607 upgrade moves, writing one JSON result file.
 *
 * Read-only by construction. The mutating twins of these APIs
 * (setAsDefaultProtocolClient, setLoginItemSettings, shell.openPath on a real
 * path) write OS state — LaunchServices registrations, login items, opening a
 * file in Finder — so each is probed through its reading counterpart and the
 * mutation is recorded as a named skip instead. A harness that changes the
 * developer's machine to prove an upgrade works is not one anybody will run.
 */
const { app, BrowserWindow, session, shell, clipboard, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = { probes: {}, skips: {}, versions: {}, fatal: null };
const rec = (name, fn) => { try { out.probes[name] = { ok: true, value: fn() }; } catch (e) { out.probes[name] = { ok: false, error: String(e && e.message || e) }; } };

const outPath = process.argv.find(a => a.startsWith('--out='))?.slice('--out='.length);

function finish(code) {
  try { fs.writeFileSync(outPath, JSON.stringify(out, null, 2)); } catch (e) { console.error('fixture: write failed', e); code = 90; }
  app.exit(code);
}

// A fixture that hangs is the classic failure here, and it would look like a
// harness bug rather than a product one. Bound it from the inside too.
const selfTimeout = setTimeout(() => { out.fatal = 'fixture self-timeout'; finish(91); }, 25000);
selfTimeout.unref?.();

out.versions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 };

// Single-instance lock: the second-instance IPC path is one of the advisories.
rec('singleInstanceLock', () => app.requestSingleInstanceLock());

app.whenReady().then(async () => {
  rec('appReady', () => true);

  // Read-only twins of the two mutating, Windows-advisory APIs.
  rec('isDefaultProtocolClient', () => app.isDefaultProtocolClient('munderdifflin'));
  rec('getLoginItemSettings', () => typeof app.getLoginItemSettings().openAtLogin);
  out.skips.setAsDefaultProtocolClient = 'mutates LaunchServices; GHSA-mwmh-mq4g-g6gr is Windows-only and unrunnable on this floor';
  out.skips.setLoginItemSettings = 'mutates login items; GHSA-jfqx-fxh3-c62j is Windows-only and unrunnable on this floor';

  rec('powerMonitorReadable', () => powerMonitor.getSystemIdleState(60));
  rec('clipboardReadText', () => typeof clipboard.readText());
  rec('clipboardReadImage', () => clipboard.readImage().isEmpty() === true || clipboard.readImage().isEmpty() === false);

  // openPath on a path that cannot exist: resolves with an error string and
  // opens nothing, so the call is exercised without a side effect.
  out.probes.shellOpenPathRejectsMissing = await shell.openPath('/nonexistent-aeon1609/no/such/file')
    .then(msg => ({ ok: typeof msg === 'string' && msg.length > 0, value: msg }))
    .catch(e => ({ ok: false, error: String(e) }));

  // Permission handlers: install both, then make the renderer ask for one.
  let checkHandlerSaw = null, requestHandlerSaw = null;
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => { checkHandlerSaw = permission; return false; });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => { requestHandlerSaw = permission; cb(false); });
  rec('permissionHandlersInstalled', () => true);

  // A window with the app's real isolation settings (src/main/index.ts:2299).
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  let windowOpenSaw = null;
  win.webContents.setWindowOpenHandler(({ url }) => { windowOpenSaw = url; return { action: 'deny' }; });

  // MEASURED, not assumed (AEON-1609): a data: URL is an opaque origin with
  // isSecureContext false, and Chromium drops a geolocation request there
  // BEFORE the permission request handler is consulted — the handler looks
  // broken when it is simply never asked. A file:// origin is a secure context,
  // reaches the handler, and is also what the packaged app actually loads.
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon1609-doc-'));
  const docPath = path.join(docDir, 'probe.html');
  fs.writeFileSync(docPath, '<!doctype html><html><head><title>aeon1609</title></head><body></body></html>');

  try {
    await win.loadURL('file://' + docPath);
    out.probes.secureContext = await win.webContents.executeJavaScript('window.isSecureContext')
      .then(v => ({ ok: v === true, value: v }), e => ({ ok: false, error: String(e) }));
    rec('rendererLoads', () => true);

    // Isolation is a security boundary the jump moves: prove it from INSIDE.
    out.probes.rendererIsolated = await win.webContents.executeJavaScript(
      '({ noRequire: typeof window.require === "undefined", noProcess: typeof window.process === "undefined", noModule: typeof window.module === "undefined" })'
    ).then(v => ({ ok: v.noRequire && v.noProcess && v.noModule, value: v }), e => ({ ok: false, error: String(e) }));

    await win.webContents.executeJavaScript('window.open("https://example.invalid/aeon1609", "_blank"); true');
    await new Promise(r => setTimeout(r, 300));
    out.probes.windowOpenHandlerFired = { ok: windowOpenSaw !== null, value: windowOpenSaw };

    // The REQUEST handler is driven by an actual permission request...
    await win.webContents.executeJavaScript('navigator.geolocation.getCurrentPosition(()=>{},()=>{}); true');
    await new Promise(r => setTimeout(r, 600));
    out.probes.permissionRequestHandlerFired = { ok: requestHandlerSaw !== null, value: requestHandlerSaw };

    // ...but the CHECK handler is consulted by navigator.permissions.query,
    // not by the request flow. Measured: a request alone never reaches it.
    await win.webContents.executeJavaScript('navigator.permissions.query({ name: "geolocation" }).then(()=>{},()=>{}); true');
    await new Promise(r => setTimeout(r, 400));
    out.probes.permissionCheckHandlerFired = { ok: checkHandlerSaw !== null, value: checkHandlerSaw };
  } catch (e) {
    out.fatal = String(e && e.stack || e);
  }

  // Native modules. These are the ABI surface the version jump actually breaks,
  // and the break shows up at first USE inside Electron — not at package time —
  // so a wrong-ABI rebuild produces a DMG that builds clean and dies when the
  // user opens a terminal.
  //
  // Both probes must EXERCISE the module, not merely require it. Measured, not
  // assumed: node-pty ships several artifacts (prebuilds/<platform> from the
  // install, plus build/Release and bin/darwin-arm64-<abi> from electron-rebuild).
  // With both Electron-ABI copies removed, `require('node-pty')` still SUCCEEDS
  // — it falls back to the Node-ABI prebuild — and the failure only appears when
  // a pty is actually spawned ("posix_spawnp failed"). A require-only probe is
  // therefore worthless here: it passes with the wrong binary loaded.
  out.probes.nativeSqlite = await (async () => {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.exec('CREATE TABLE t (k TEXT, v INTEGER)');
      db.prepare('INSERT INTO t VALUES (?, ?)').run('aeon1609', 42);
      const row = db.prepare('SELECT v FROM t WHERE k = ?').get('aeon1609');
      db.close();
      return { ok: row && row.v === 42, value: row };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })();

  out.probes.nativePty = await (async () => {
    try {
      const pty = require('node-pty');
      const p = pty.spawn('/bin/echo', ['aeon1609-pty-ok'], { name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      const text = await new Promise((resolve) => {
        let buf = '';
        const t = setTimeout(() => resolve(buf), 4000);
        p.onData(d => { buf += d; if (buf.includes('aeon1609-pty-ok')) { clearTimeout(t); resolve(buf); } });
      });
      try { p.kill(); } catch { /* already exited */ }
      return { ok: text.includes('aeon1609-pty-ok'), value: text.trim().slice(0, 60) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })();

  clearTimeout(selfTimeout);
  finish(0);
}).catch(e => { out.fatal = String(e && e.stack || e); finish(92); });
