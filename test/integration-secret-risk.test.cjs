'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  LOCAL_PROCESS_SECRET_WARNING,
  integrationSecretRiskWarning
} = loadTs('src/main/integrationSecretRisk.ts');

test('macOS with stored secrets warns about the actual same-user boundary', () => {
  assert.equal(integrationSecretRiskWarning('darwin', 1), LOCAL_PROCESS_SECRET_WARNING);
  assert.match(LOCAL_PROCESS_SECRET_WARNING, /does not bind.*code identity/i);
  assert.match(LOCAL_PROCESS_SECRET_WARNING, /processes running as your macOS user/i);
  assert.doesNotMatch(LOCAL_PROCESS_SECRET_WARNING, /secure|protected from other apps/i);
});

test('no secret means no warning, and other platforms do not inherit a macOS claim', () => {
  assert.equal(integrationSecretRiskWarning('darwin', 0), undefined);
  assert.equal(integrationSecretRiskWarning('linux', 2), undefined);
  assert.equal(integrationSecretRiskWarning('win32', 2), undefined);
});

test('startup wiring is presence-only and warns after the window exists', () => {
  const root = path.resolve(__dirname, '..');
  const integrations = fs.readFileSync(path.join(root, 'src/main/integrations.ts'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(integrations, /integrationSecretRiskWarning\(platform, Object\.keys\(readSecretBlob\(\)\)\.length\)/);
  const create = main.indexOf('createWindow();', main.indexOf('app.whenReady().then'));
  const warning = main.indexOf('integrations.startupSecretBoundaryWarning();', create);
  const dialog = main.indexOf('dialog.showMessageBox', warning);
  assert.ok(create >= 0 && warning > create && dialog > warning);
  assert.doesNotMatch(main.slice(warning, dialog), /getSecret|decryptString|secretRef/);
});
