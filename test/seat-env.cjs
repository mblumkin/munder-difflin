'use strict';
// AEON-2686: what a sandboxed agent seat denies. Each probe returns false when the
// primitive works, or a SKIP-ENV reason naming the precondition when this seat
// refuses it. Pass the result as node:test's `skip` option, so a sandboxed run
// names the skip instead of going red, and a host run (every probe false) still
// runs and fails on a real defect. Probes run once per process, lazily.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = new Map();
const once = (key, fn) => () => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
const deniedCode = (code) => code === 'EPERM' || code === 'EACCES';
const reason = (what) => `SKIP-ENV: ${what}; run on an unsandboxed host to measure it`;

// listen() on a Unix socket in os.tmpdir() (the dir every socket test uses first).
const unixSocket = once('unixSocket', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-'));
  const sock = path.join(dir, 's.sock');
  const r = spawnSync(process.execPath, ['-e',
    `const s=require('node:net').createServer();s.on('error',e=>{console.log(e.code);process.exit(1)});s.listen(${JSON.stringify(sock)},()=>s.close(()=>process.exit(0)))`],
  { encoding: 'utf8', timeout: 10_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const code = (r.stdout || '').trim();
  return r.status !== 0 && deniedCode(code) ? reason(`listen() on a Unix socket is refused with ${code}`) : false;
});

// A write directly under $HOME (the ~-expansion tests create a real file there).
const homeWrite = once('homeWrite', () => {
  const f = path.join(os.homedir(), `.md-seat-probe-${process.pid}`);
  try { fs.writeFileSync(f, ''); fs.unlinkSync(f); return false; } catch (e) {
    return deniedCode(e.code) ? reason(`writing under $HOME is refused with ${e.code}`) : false;
  }
});

// ps and pgrep over this process's own tree: a sandboxed seat cannot list processes.
const processTable = once('processTable', () => {
  const ps = spawnSync('ps', ['-p', String(process.pid), '-o', 'pid='], { encoding: 'utf8' });
  if (ps.status === 0 && ps.stdout.trim() === String(process.pid)) return false;
  const why = (ps.stderr || '').trim() || (ps.error && ps.error.code) || `exit ${ps.status} signal ${ps.signal}`;
  return reason(`ps cannot list this process (${why})`);
});

// node-pty spawning /usr/bin/true. A non-executable spawn-helper (an install defect)
// fails the same way, so test/pty-spawn-helper-mode.test.cjs stays the check for that.
const ptySpawn = once('ptySpawn', () => {
  const r = spawnSync(process.execPath, ['-e',
    "try{const t=require('node-pty').spawn('/usr/bin/true',[],{});t.onExit(()=>process.exit(0))}catch(e){console.log(e.message);process.exit(1)}"],
  { encoding: 'utf8', timeout: 10_000, cwd: path.join(__dirname, '..') });
  const msg = (r.stdout || '').trim();
  return r.status !== 0 && /posix_spawnp failed/.test(msg) ? reason(`node-pty cannot spawn a pty (${msg})`) : false;
});

// sandbox-exec inside this process: codex applies its own Seatbelt profile, which a
// seat already under Seatbelt refuses.
const nestedSandbox = once('nestedSandbox', () => {
  if (process.platform !== 'darwin') return false;
  const r = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
  return r.status === 0 ? false : reason(`a nested sandbox-exec is refused (${(r.stderr || '').trim() || `exit ${r.status}`})`);
});

module.exports = { unixSocket, homeWrite, processTable, ptySpawn, nestedSandbox };
