#!/usr/bin/env node
'use strict';
/**
 * Windows-only node-pty crash guard, re-applied on every install (postinstall,
 * after electron-rebuild). No-op on non-Windows and when already patched.
 *
 * node-pty forks `conpty_console_list_agent.js` to enumerate console processes
 * when a pty is killed/exits. For a child whose console is already gone — e.g.
 * an agent CLI that manages its own console and exits fast (Antigravity's `agy`)
 * — `getConsoleProcessList(shellPid)` throws "AttachConsole failed" UNCAUGHT in
 * that forked helper, which cascades into a whole-app crash (exit 255). Wrap it
 * so it degrades to an empty list instead.
 *
 * AEON-1610: this script used to FAIL OPEN. Every way of not-patching exited 0:
 * a missing agent file, and — the dangerous one — a source whose expected text
 * no longer matched, which is indistinguishable from "already patched" if you
 * only test for the original string. A node-pty bump could therefore silently
 * stop applying the guard while postinstall still reported success and
 * packaging still produced a DMG, bringing back a whole-app crash nobody was
 * watching for. Each edit is now checked independently against BOTH its
 * original and its patched form, and anything else is a loud non-zero exit.
 *
 * The matching logic is a pure function so it can be tested off Windows. The
 * platform gate below is why this was never exercised: on a macOS-only floor
 * every run returned at the first line.
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const GUARDED_LIST =
  'var consoleProcessList = [];\n' +
  '// PATCHED: AttachConsole can fail when the shell console is already gone (e.g.\n' +
  "// a fast-exiting agent CLI that owns its console). Don't let the uncaught throw\n" +
  '// crash this forked helper and cascade into a whole-app crash.\n' +
  'try { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) { consoleProcessList = []; }';

const GUARDED_SEND =
  'try { process.send({ consoleProcessList: consoleProcessList }); } catch (e) { /* parent gone */ }';

// Each edit carries the text it replaces AND the text it produces, so "already
// applied" is a positive observation rather than the absence of a match.
const EDITS = [
  { name: 'getConsoleProcessList guard', from: 'var consoleProcessList = getConsoleProcessList(shellPid);', to: GUARDED_LIST },
  { name: 'process.send guard', from: 'process.send({ consoleProcessList: consoleProcessList });', to: GUARDED_SEND },
];

/**
 * Decide what to do with a given source. Pure: no fs, no platform checks.
 * Returns { ok, out, applied: [names], already: [names], missing: [names] }.
 * ok is false when any edit can be neither applied nor confirmed already applied.
 */
function planPatch(src, edits = EDITS) {
  let out = src;
  const applied = [], already = [], missing = [];
  for (const edit of edits) {
    if (out.includes(edit.to)) { already.push(edit.name); continue; }
    if (out.includes(edit.from)) { out = out.replace(edit.from, edit.to); applied.push(edit.name); continue; }
    missing.push(edit.name);
  }
  return { ok: missing.length === 0, out, applied, already, missing };
}

function main() {
  if (process.platform !== 'win32') return 0;

  const agent = join(__dirname, '..', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js');
  if (!existsSync(agent)) {
    // On Windows node-pty is a production dependency; its absence here means the
    // install is broken or restructured, not that there is nothing to do.
    console.error(`[patch-node-pty-conpty] FAILED: node-pty's conpty_console_list_agent.js is missing at ${agent}`);
    return 1;
  }

  const src = readFileSync(agent, 'utf8');
  const plan = planPatch(src);

  if (!plan.ok) {
    console.error('[patch-node-pty-conpty] FAILED: could not find the text to guard, and it is not already guarded.');
    for (const name of plan.missing) console.error(`  - ${name}`);
    console.error('  node-pty probably changed conpty_console_list_agent.js. Re-derive the patch against the new');
    console.error('  source before shipping Windows: unguarded, a fast-exiting agent CLI crashes the whole app (exit 255).');
    return 1;
  }

  if (plan.applied.length > 0) {
    writeFileSync(agent, plan.out, 'utf8');
    console.log(`[patch-node-pty-conpty] guarded conpty_console_list_agent (${plan.applied.join(', ')})`);
  } else {
    console.log('[patch-node-pty-conpty] already guarded, nothing to do');
  }
  return 0;
}

module.exports = { planPatch, EDITS, GUARDED_LIST, GUARDED_SEND };

if (require.main === module) process.exit(main());
