'use strict';
/**
 * AEON-1596: the opencode and pi bridges posted PostToolUse with a tool name and NO tool_input,
 * so the breaker hashed every call to the same key and read varied sessions as "Nx identical".
 * Runs the REAL bridge text (extracted from src/main/hive.ts) against a live unix socket, drives
 * the plugin's hooks with distinct commands, and asserts each PostToolUse carries its own input.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp('const ' + name + " = `([\\s\\S]*?)`;\\n"));
  assert.ok(m, name + ' not found in hive.ts');
  return m[1].replace(/\\\\/g, '\\');
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
const sock = path.join(dir, 's.sock');
const got = [];
const server = net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { for (const l of buf.split('\n')) if (l.trim()) got.push(JSON.parse(l)); });
});

const settle = () => new Promise((r) => setTimeout(r, 150));
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

server.listen(sock, async () => {
  process.env.HIVE_SOCK = sock;
  process.env.AGENT_ID = 'probe';

  await test('opencode plugin: each PostToolUse carries its own args (distinct calls stay distinct)', async () => {
    const file = path.join(dir, 'oc.mjs');
    fs.writeFileSync(file, grab('OPENCODE_PLUGIN'));
    const mod = await import('file://' + file);
    const hooks = await mod.HiveBridge();
    got.length = 0;
    for (const [id, cmd] of [['c1', 'ls'], ['c2', 'cat x'], ['c3', 'ls']]) {
      await hooks['tool.execute.before']({ tool: 'bash', callID: id }, { args: { command: cmd } });
      await hooks['tool.execute.after']({ tool: 'bash', callID: id }, { output: 'ok' });
    }
    await settle();
    const post = got.filter((g) => g.hook_event_name === 'PostToolUse');
    assert.equal(post.length, 3);
    assert.deepEqual(post.map((p) => p.tool_input && p.tool_input.command).sort(), ['cat x', 'ls', 'ls']);
  });

  await test('pi extension: PostToolUse carries the args seen on tool_call', async () => {
    const file = path.join(dir, 'pi.cjs');
    fs.writeFileSync(file, grab('PI_EXTENSION'));
    const handlers = {};
    require(file)({ on: (n, f) => { handlers[n] = f; } });
    got.length = 0;
    handlers.tool_call({ id: 'a', name: 'bash', args: { command: 'one' } });
    handlers.tool_result({ id: 'a', name: 'bash' });
    handlers.tool_call({ id: 'b', name: 'bash', args: { command: 'two' } });
    handlers.tool_result({ id: 'b', name: 'bash' });
    await settle();
    const post = got.filter((g) => g.hook_event_name === 'PostToolUse');
    assert.deepEqual(post.map((p) => p.tool_input && p.tool_input.command), ['one', 'two']);
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
});
