'use strict';
/**
 * AEON-1607 stage 3: the packaged app must actually contain its native modules.
 *
 * WHY: electron-builder bundles PRODUCTION dependencies. During stage 2 a single
 * `npm install --save-dev` moved better-sqlite3 and node-pty out of
 * `dependencies`, and the resulting app.asar.unpacked contained ZERO .node files
 * for either module while electron-builder still exited 0. Nothing in this repo
 * could have caught it: every other test runs against a dev tree, which always
 * has node_modules, so the app "works" right up until a user opens a terminal or
 * touches the database in the SHIPPED build.
 *
 * This file is the cheap half — a manifest check that fails in milliseconds on
 * exactly that mistake. The expensive half, which measures the real artifact
 * rather than a proxy for it, is `npm run test:packaging` (tools/check-packaged-natives.cjs):
 * it packs the app and looks for the .node files inside the bundle. Both exist
 * on purpose. The manifest check catches the regression that actually happened,
 * at a cost that lets it run in every suite; the pack check is the one that
 * cannot be fooled by a manifest that looks right for the wrong reason.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

// Modules with a compiled .node binary that the SHIPPED app loads at runtime.
const NATIVE_RUNTIME_MODULES = ['better-sqlite3', 'node-pty'];

for (const name of NATIVE_RUNTIME_MODULES) {
  test(`${name} is a production dependency, so electron-builder bundles it`, () => {
    assert.ok(
      pkg.dependencies && pkg.dependencies[name],
      `${name} must be in "dependencies". In "devDependencies" it is silently excluded from the ` +
      `packaged app: electron-builder still exits 0 and no dev-tree test can tell.`
    );
    assert.ok(
      !(pkg.devDependencies && pkg.devDependencies[name]),
      `${name} must not ALSO be in devDependencies`
    );
  });

  test(`${name} is asarUnpacked, so its .node binary is loadable from disk`, () => {
    assert.ok(
      builderYml.includes(`node_modules/${name}/**`),
      `electron-builder.yml must asarUnpack ${name}: a .node file cannot be dlopen'd from inside an asar archive`
    );
  });
}
