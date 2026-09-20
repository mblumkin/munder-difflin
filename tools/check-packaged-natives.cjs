#!/usr/bin/env node
'use strict';
/**
 * AEON-1607 stage 3: pack the app and assert the native modules are really in it.
 *
 * This measures the ARTIFACT. The manifest check in
 * test/packaging-native-inclusion.test.cjs is a fast proxy for the one mistake we
 * actually made; this is the check that cannot be fooled. It found a second,
 * unrelated defect the first time it ran: electron-builder 26 OOMs while
 * searching node_modules and produces no bundle at all (AEON-1617).
 *
 * Not in test:focused because it packs a real app. Run it before a release, and
 * after any change to dependencies, electron-builder config, or the Electron
 * version.
 *
 * Usage: node tools/check-packaged-natives.cjs [--skip-pack]
 *   --skip-pack  reuse an existing dist/ build instead of packing again
 */
const { execFileSync } = require('node:child_process');
const { readdirSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

const NATIVE_RUNTIME_MODULES = ['better-sqlite3', 'node-pty'];
const root = join(__dirname, '..');

function findNodeFiles(dir, moduleName, found = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findNodeFiles(p, moduleName, found);
    else if (e.name.endsWith('.node') && p.includes(`node_modules/${moduleName}/`)) found.push(p);
  }
  return found;
}

function main() {
  const skipPack = process.argv.includes('--skip-pack');
  if (!skipPack) {
    console.log('check-packaged-natives: packing (electron-builder --dir)…');
    try {
      execFileSync('npx', ['electron-builder', '--dir', '-c.mac.identity=null'], { cwd: root, stdio: 'inherit' });
    } catch (e) {
      console.error('check-packaged-natives: FAILED — electron-builder could not produce a bundle.');
      console.error(`  ${e && e.message}`);
      return 1;
    }
  }

  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) { console.error('check-packaged-natives: FAILED — no dist/ directory'); return 1; }

  // Whatever platform dir the pack produced (mac-arm64, mac, win-unpacked, linux-unpacked…).
  const packDirs = readdirSync(distDir).map(n => join(distDir, n)).filter(p => statSync(p).isDirectory());
  if (packDirs.length === 0) { console.error('check-packaged-natives: FAILED — dist/ holds no packaged output'); return 1; }

  let failures = 0;
  for (const name of NATIVE_RUNTIME_MODULES) {
    const hits = packDirs.flatMap(d => findNodeFiles(d, name));
    if (hits.length === 0) {
      failures++;
      console.error(`  FAIL  ${name}: NO .node binary in the packaged app`);
      console.error(`        The bundle would ship without it and die at first use. Check that ${name} is in`);
      console.error(`        "dependencies" (not devDependencies) and asarUnpacked in electron-builder.yml.`);
    } else {
      console.log(`  ok    ${name}: ${hits.length} .node file(s) in the packaged app`);
      console.log(`          e.g. ${hits[0].slice(root.length + 1)}`);
    }
  }

  if (failures > 0) { console.error(`\ncheck-packaged-natives: ${failures} native module(s) MISSING from the bundle`); return 1; }
  console.log('\ncheck-packaged-natives: all native modules present in the packaged app');
  return 0;
}

if (require.main === module) process.exit(main());
