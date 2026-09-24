'use strict';

// AEON-1705: a codex worker gets the same PreToolUse guards a claude worker gets.
// installCodexHooks mirrors every Bash-matching PreToolUse hook from the user's Claude
// settings into the worker's CODEX_HOME/config.toml. The last case runs the real codex
// CLI against a scripted local model and proves a denied command never runs and the
// reason reaches the model; it skips where codex is not installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codexguard-'));
const realHome = process.env.HOME;
process.env.HOME = home; // installCodexHooks reads ~/.claude and ~/.codex via homedir()
const loadTs = require('./load-ts.cjs');
const { claudeGuards, codexGuardHooksToml } = loadTs('src/main/codexGuardHooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const GUARD = path.join(__dirname, 'fixtures', 'codex-guard-deny.cjs');
const settings = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [
        { type: 'command', command: `node "${GUARD}"` },
        { type: 'command', command: 'bash "$HOME/guards/shared.sh"', timeout: 10 },
      ] },
      { matcher: 'Write|Edit|MultiEdit', hooks: [
        { type: 'command', command: 'bash "$HOME/guards/shared.sh"' },
        { type: 'command', command: 'bash "$HOME/guards/write-only.sh"' },
      ] },
      { matcher: '*', hooks: [{ type: 'command', command: 'bash "$HOME/guards/all.sh"', timeout: 0 }] },
      { matcher: '([', hooks: [{ type: 'command', command: 'bash "$HOME/guards/bad-regex.sh"' }] },
    ],
  },
};

test('Bash groups mirror as Bash, Write/Edit groups as apply_patch, deduplicated, codex-safe timeouts', () => {
  const got = claudeGuards(settings).bash;
  assert.deepEqual(got.map((h) => h.command), [
    `node "${GUARD}"`, 'bash "$HOME/guards/shared.sh"', 'bash "$HOME/guards/all.sh"',
  ]);
  assert.equal(got[1].timeout, 10);
  assert.equal(got[2].timeout, 30, "Claude's 0 must not become codex's 1-second floor");
  // AEON-1706: codex edits files via apply_patch, so file-tool guards mirror there.
  assert.deepEqual(claudeGuards(settings).applyPatch.map((h) => h.command), [
    'bash "$HOME/guards/shared.sh"', 'bash "$HOME/guards/write-only.sh"', 'bash "$HOME/guards/all.sh"',
  ]);
  assert.deepEqual(claudeGuards({}), { bash: [], applyPatch: [] });
  assert.equal(codexGuardHooksToml({ bash: [], applyPatch: [] }), '');
});

test('installCodexHooks writes the mirrored guards into the worker config', () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const agentDir = fs.mkdtempSync(path.join(home, 'agent-'));
  const hive = new HiveManager(() => home);
  const codexHome = hive.installCodexHooks(agentDir, 'a1');
  const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(toml, /\[\[hooks\.PreToolUse\]\]\nmatcher = "Bash"\n/);
  assert.ok(toml.includes(`command = ${JSON.stringify(`node "${GUARD}"`)}`));
  const groups = toml.split('[[hooks.PreToolUse]]\nmatcher = ');
  const bashGroup = groups.find((g) => g.startsWith('"Bash"')) || '';
  const patchGroup = groups.find((g) => g.startsWith('"apply_patch"')) || '';
  assert.ok(patchGroup.includes('write-only.sh'), 'a Write|Edit guard is mirrored under apply_patch (AEON-1706)');
  assert.ok(!bashGroup.includes('write-only.sh'), 'and not under Bash');
});

test('CLAUDE_CONFIG_DIR is honoured the way Claude Code honours it', () => {
  const alt = fs.mkdtempSync(path.join(home, 'claudecfg-'));
  fs.writeFileSync(path.join(alt, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo from-config-dir' }] }] } }));
  process.env.CLAUDE_CONFIG_DIR = alt;
  try {
    const hive = new HiveManager(() => home);
    const toml = fs.readFileSync(path.join(hive.installCodexHooks(fs.mkdtempSync(path.join(home, 'agent-')), 'a2'), 'config.toml'), 'utf8');
    assert.ok(toml.includes('from-config-dir'));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

const codexBin = spawnSync('sh', ['-c', 'command -v codex'], { env: { ...process.env, HOME: realHome } }).stdout.toString().trim();

test('live codex: a denied command never runs and the reason reaches the model', { skip: !codexBin && 'codex CLI not installed' }, async () => {
  const agentDir = fs.mkdtempSync(path.join(home, 'agent-'));
  const work = fs.mkdtempSync(path.join(home, 'work-'));
  const hive = new HiveManager(() => home);
  const codexHome = hive.installCodexHooks(agentDir, 'a3');

  // A denied call THROWS inside a code-mode script, so each call settles on its own
  // (the shape real codex sessions use) and the control still runs.
  const script = [
    'const r = await Promise.allSettled([',
    '  tools.exec_command({cmd:"git push origin main --force; touch pushed.marker"}),',
    '  tools.exec_command({cmd:"python3 -c \\"import json; json.dump({}, open(\'tasks.json\',\'w\'))\\"; touch ledger.marker"}),',
    '  tools.exec_command({cmd:"touch allowed.marker"}),',
    ']);',
    'r.forEach((x) => text(JSON.stringify(x.status === "rejected" ? String(x.reason) : x.value)));',
  ].join('\n');
  const requests = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(body);
      const item = turn++ === 0
        ? { type: 'custom_tool_call', id: 'ct_1', call_id: 'call_1', name: 'exec', input: script, status: 'completed' }
        : { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
      const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of [
        { type: 'response.created', response: { id: `r${turn}`, object: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `r${turn}`, object: 'response', status: 'completed', output: [item], usage } },
      ]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.appendFileSync(path.join(codexHome, 'config.toml'), [
    '', 'model = "mock-model"', 'model_provider = "mock"', '[model_providers.mock]', 'name = "mock"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'env_key = "MOCK_KEY"', '',
  ].join('\n'));
  // TOML keys after a table header belong to it, so the top-level keys above must precede any table.
  const cfg = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  const top = 'model = "mock-model"\nmodel_provider = "mock"\n';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), top + cfg.replace(top, ''));

  const code = await new Promise((resolve) => {
    const p = spawn(codexBin, ['exec', '--enable', 'code_mode_only', '--dangerously-bypass-hook-trust',
      '-c', 'approval_policy="never"', '-s', 'workspace-write', '--skip-git-repo-check', 'go'],
      { cwd: work, env: { ...process.env, HOME: home, CODEX_HOME: codexHome, MOCK_KEY: 'x' }, stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('close', resolve);
  });
  server.close();
  assert.equal(code, 0);
  assert.equal(requests.length, 2, 'the model got a second turn carrying the tool results');
  assert.ok(fs.existsSync(path.join(work, 'allowed.marker')), 'control: an allowed command still runs');
  assert.ok(!fs.existsSync(path.join(work, 'pushed.marker')), 'the force-push command must not run');
  assert.ok(!fs.existsSync(path.join(work, 'ledger.marker')), 'the unlocked tasks.json write must not run');
  const back = requests[1];
  assert.match(back, /blocked by PreToolUse hook: FIXTURE: force-push is blocked/);
  assert.match(back, /blocked by PreToolUse hook: FIXTURE: unlocked tasks.json write is blocked/);
});
