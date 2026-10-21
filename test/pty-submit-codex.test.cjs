'use strict';

/**
 * AEON-2468: a Codex seat sat 95 minutes with "read your inbox" typed into its prompt and never sent.
 *
 * MD types a nudge as text, then "\r" PTY_SUBMIT_ENTER_DELAY_MS later. Codex reads a raw burst of characters as a
 * paste and turns an Enter it processes within 120 ms of the burst's last processed character into a newline
 * (codex-rs tui paste_burst.rs: PASTE_BURST_CHAR_INTERVAL 8 ms, PASTE_ENTER_SUPPRESS_WINDOW 120 ms, and an
 * explicit bracketed paste clears the window). The window runs from when Codex READS the text, so a TUI busy for
 * 20 ms or more eats the Enter. The fake composer below applies those rules to the exact writes MD makes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');

/** The one helper both nudge paths type through. Before AEON-2468 each path inlined "raw unless multi-line". */
function submitPlan() {
  let mod = null;
  try { mod = loadTs('src/shared/ptySubmit.ts'); } catch (_) { /* asserted below */ }
  assert.ok(mod && typeof mod.ptySubmitPayload === 'function', 'no shared ptySubmitPayload: both nudge paths type a one-line nudge raw');
  return mod;
}

const OPEN = '\x1b[200~', CLOSE = '\x1b[201~', SUPPRESS_MS = 120;

/** Feed timed writes to a Codex-like composer that is busy (reads nothing) until `busyUntil` ms. */
function codexComposer(writes, busyUntil) {
  let composer = '', submitted = null, windowUntil = null;
  for (const { at, data } of writes) {
    const readAt = Math.max(at, busyUntil);   // input written while busy is read, in order, once it frees up
    let rest = data;
    while (rest.length) {
      if (rest.startsWith(OPEN)) {
        const end = rest.indexOf(CLOSE);
        composer += rest.slice(OPEN.length, end);
        windowUntil = null;   // clear_after_explicit_paste
        rest = rest.slice(end + CLOSE.length);
        continue;
      }
      if (rest[0] === '\r') {
        if (windowUntil !== null && readAt <= windowUntil) composer += '\n';
        else { submitted = composer; composer = ''; }
        rest = rest.slice(1);
        continue;
      }
      // A run of plain characters read in one go arrives far inside 8 ms per char: a burst once it reaches 3.
      const run = rest.match(/^[^\r\x1b]+/)[0];
      composer += run;
      if (run.length >= 3) windowUntil = readAt + SUPPRESS_MS;
      rest = rest.slice(run.length);
    }
  }
  return { submitted, composer };
}

const typed = (provider, text) => {
  const { ptySubmitPayload, PTY_SUBMIT_ENTER_DELAY_MS } = submitPlan();
  return [{ at: 0, data: ptySubmitPayload(text, provider) }, { at: PTY_SUBMIT_ENTER_DELAY_MS, data: '\r' }];
};
const NUDGE = inboxNudgeText(['2026-10-20T23-45-11-408Z-d0161b']);
const LAGS = [0, 30, 100, 139, 140, 500, 5000];

test('the Codex preset asks for bracketed submits', () => {
  assert.equal(providerPreset('codex').bracketedSubmit, true);
});

test('a Codex nudge submits however late the TUI reads it', () => {
  for (const lag of LAGS) {
    const r = codexComposer(typed('codex', NUDGE), lag);
    assert.equal(r.submitted, NUDGE, `read lag ${lag} ms: ${JSON.stringify(r).slice(0, 120)}`);
    assert.equal(r.composer, '', `read lag ${lag} ms left text in the prompt`);
  }
});

test('control: raw text and a 140 ms Enter leave the nudge typed but unsent once Codex reads 30 ms late', () => {
  const raw = [{ at: 0, data: NUDGE }, { at: 140, data: '\r' }];
  assert.equal(codexComposer(raw, 0).submitted, NUDGE, 'an idle TUI does submit it, which is why this hid');
  const late = codexComposer(raw, 30);
  assert.equal(late.submitted, null);
  assert.equal(late.composer, `${NUDGE}\n`, 'the Enter became a newline in the prompt, as seen on the seat');
});

test('a one-line prompt stays raw for providers that do not ask for brackets (agy reads the markers literally)', () => {
  const { ptySubmitPayload } = submitPlan();
  for (const provider of ['claude', 'antigravity', undefined]) assert.equal(ptySubmitPayload(NUDGE, provider), NUDGE, String(provider));
});

test('multi-line text is bracketed for every provider, so its newlines do not submit early', () => {
  const { ptySubmitPayload } = submitPlan();
  for (const provider of ['claude', 'codex', undefined]) assert.equal(ptySubmitPayload('a\nb', provider), `${OPEN}a\nb${CLOSE}`, String(provider));
});

test('Enter goes as its own write after the text, with time for the TUI to take the text first', () => {
  const { PTY_SUBMIT_ENTER_DELAY_MS } = submitPlan();
  assert.ok(PTY_SUBMIT_ENTER_DELAY_MS >= 100, String(PTY_SUBMIT_ENTER_DELAY_MS));
});
