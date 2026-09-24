/**
 * AEON-1697: a screenshot paste that fails must say so.
 *
 * The composer swallows the paste event before asking main to persist the
 * clipboard image, so when saveClipboardImage returned ok:false the paste
 * simply vanished: a failure read exactly like "paste did nothing". The
 * helper is driven with fakes (no jsdom harness in this repo); the component
 * wiring is checked from source so deleting the visible error cannot pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { pasteClipboardImage } = loadTs('src/renderer/src/components/clipboardImagePaste.ts');

function run(save) {
  const attached = [];
  const failed = [];
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  return pasteClipboardImage(save, (f) => attached.push(f), (e) => failed.push(e))
    .finally(() => { console.warn = warn; })
    .then(() => ({ attached, failed, warned }));
}

test('ok:false reports the error and attaches nothing', async () => {
  const r = await run(async () => ({ ok: false, error: 'no image in clipboard' }));
  assert.deepEqual(r.failed, ['no image in clipboard']);
  assert.deepEqual(r.attached, []);
  assert.ok(r.warned.some((w) => w.includes('no image in clipboard')), 'a console line names the error');
});

test('a rejected IPC call is reported, not thrown past the paste handler', async () => {
  const r = await run(async () => { throw new Error('ipc gone'); });
  assert.deepEqual(r.failed, ['ipc gone']);
  assert.deepEqual(r.attached, []);
});

test('ok:true attaches the file and reports nothing', async () => {
  const file = { path: '/tmp/paste.png', name: 'paste.png' };
  const r = await run(async () => ({ ok: true, file }));
  assert.deepEqual(r.attached, [file]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.warned, []);
});

test('the composer routes the image paste through the helper and renders the error', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/src/components/MessageQueueComposer.tsx'), 'utf8');
  assert.match(src, /pasteClipboardImage\(\s*\(\) => window\.cth\.saveClipboardImage\(\)/);
  assert.match(src, /setPasteError\s*\)/, 'the failure callback must set the visible error');
  assert.match(src, /\{pasteError && \(/, 'the error must render');
  assert.match(src, /t\('queueComposer\.pasteFailed'\)/);
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(readFileSync(join(__dirname, '..', `src/renderer/src/i18n/locales/${loc}.json`), 'utf8'));
    assert.ok(json.queueComposer && json.queueComposer.pasteFailed, `${loc} has queueComposer.pasteFailed`);
  }
});
