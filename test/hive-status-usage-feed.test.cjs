'use strict';
// AEON-2594: the generated cth-hook.cjs feeds each status payload to ~/.claude/statusline.sh,
// the writer of usage-window.json (the hive's 95% weekly park rule reads it). The hive added the
// feed by hand (AEON-2541) and ensureHive rewrote the file without it, so it lives here now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';
const PAYLOAD = JSON.stringify({
  context_window: { total_input_tokens: 12345, context_window_size: 200000 },
  rate_limits: { seven_day: { used_percentage: 91, resets_at: 123 } }
});

function runShim(shim, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim, '--status'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(PAYLOAD);
  });
}

async function waitFor(file, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-status-feed-'));
  const hive = new HiveManager(() => path.join(base, 'harness'));
  t.after(async () => {
    await hive.flushGit();
    fs.rmSync(base, { recursive: true, force: true });
  });
  hive.ensureHive();
  const home = path.join(base, 'user');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, HIVE_SOCK: '', AGENT_ID: 'a1' };
  return { home, env, shim: path.join(base, 'harness', 'hive', 'bin', 'cth-hook.cjs') };
}

test('the generated status shim feeds the usage writer and keeps its own stdout', { skip: !POSIX }, async (t) => {
  const { home, env, shim } = setup(t);
  const out = path.join(home, 'usage-window.json');
  fs.writeFileSync(path.join(home, '.claude', 'statusline.sh'),
    `#!/usr/bin/env bash\nsleep 1\ncat > "${out}"\nprintf 'UNWANTED STATUSLINE OUTPUT\\n'\n`, { mode: 0o755 });

  const r = await runShim(shim, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ctx 12k/200k (6%)', 'the writer leaked into the status line');
  assert.ok(await waitFor(out), 'the usage writer never ran');
  assert.equal(fs.readFileSync(out, 'utf8'), PAYLOAD, 'the writer got different JSON');
});

test('with no usage writer the status shim is unchanged and writes nothing', { skip: !POSIX }, async (t) => {
  const { home, env, shim } = setup(t);
  const r = await runShim(shim, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ctx 12k/200k (6%)');
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), []);
});
