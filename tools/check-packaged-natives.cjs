#!/usr/bin/env node
'use strict';
/**
 * AEON-1607 stage 3: pack the app and assert the native modules are really in it.
 * Stage 4 widened it: the raw .cjs sidecars are checked in the same pass.
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
const { readdirSync, existsSync, statSync, openSync, readSync, closeSync } = require('node:fs');
const { join } = require('node:path');

const NATIVE_RUNTIME_MODULES = ['better-sqlite3', 'node-pty'];

// Raw .cjs files the main process require()s at runtime. Nothing bundles or
// copies these automatically: electron.vite.config.ts's copyMainSidecars() hook
// emits the in-asar pair and electron-builder.yml's extraResources block emits
// the out-of-asar CLI helpers. A missing one crashed the packaged app (#66) and
// `npm run dev` (#67), and neither the suite nor the native walk above sees it,
// because these ship INSIDE app.asar rather than on the plain filesystem.
const ASAR_SIDECARS = ['out/main/slack-trigger.cjs', 'out/main/kg-core.cjs'];
const RESOURCE_SIDECARS = ['md-slack-reply.cjs', 'kg.cjs', 'kg-core.cjs'];

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

// Minimal asar reader: a 16-byte pickle header, then a JSON directory tree.
// Reading the header beats shelling out to @electron/asar, which is only present
// transitively via electron-builder and is not a declared dependency here.
function readAsarEntries(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    readSync(fd, json, 0, jsonLen, 16);
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

// Returns the entry's size, or null when any path segment is absent.
function asarEntrySize(tree, relPath) {
  let node = tree;
  for (const seg of relPath.split('/')) {
    if (!node || !node.files || !node.files[seg]) return null;
    node = node.files[seg];
  }
  return typeof node.size === 'number' ? node.size : null;
}

function checkSidecars(packDirs) {
  let failures = 0;

  for (const dir of packDirs) {
    // macOS nests resources one level deeper than win/linux.
    const resourceDirs = [
      ...readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.endsWith('.app'))
        .map(e => join(dir, e.name, 'Contents', 'Resources')),
      join(dir, 'resources')
    ].filter(existsSync);

    for (const res of resourceDirs) {
      const asarPath = join(res, 'app.asar');
      if (existsSync(asarPath)) {
        const tree = readAsarEntries(asarPath);
        for (const rel of ASAR_SIDECARS) {
          const size = asarEntrySize(tree, rel);
          if (!size) {
            failures++;
            console.error(`  FAIL  sidecar ${rel}: ${size === null ? 'ABSENT from' : 'EMPTY inside'} app.asar`);
            console.error('        The main process require()s it at boot and would die there. Check');
            console.error("        copyMainSidecars() in electron.vite.config.ts.");
          } else {
            console.log(`  ok    sidecar ${rel}: ${size} bytes inside app.asar`);
          }
        }
      }

      for (const name of RESOURCE_SIDECARS) {
        const p = join(res, name);
        const size = existsSync(p) ? statSync(p).size : null;
        if (!size) {
          failures++;
          console.error(`  FAIL  resource ${name}: ${size === null ? 'ABSENT from' : 'EMPTY in'} ${res.slice(root.length + 1)}`);
          console.error('        Agents invoke it out-of-process by path. Check extraResources in electron-builder.yml.');
        } else {
          console.log(`  ok    resource ${name}: ${size} bytes beside the app`);
        }
      }
    }
  }

  return failures;
}

function main() {
  const skipPack = process.argv.includes('--skip-pack');
  if (!skipPack) {
    // AEON-1625: pack UNIVERSAL, not a single architecture.
    //
    // This gate used to run a plain `--dir`, which on this machine packs arm64
    // alone. That cannot certify a universal release, and the gap is not
    // theoretical: AEON-1607 stage 5 passed this gate green and still shipped a
    // universal build that could not be produced at all. Stage 5 moved native
    // rebuilds to `electron-builder install-app-deps`, so both natives began
    // shipping prebuilds for every platform and arch; @electron/universal then
    // refuses the merge when a file is byte-identical in both halves and looks
    // arch-specific. A single-arch pack never performs that merge, so it never
    // sees the failure.
    //
    // Measured before choosing this, rather than assumed (seconds, this box):
    //   single-arch --dir   12s, exits 0 WITH OR WITHOUT the x64ArchFiles fix
    //   universal   --dir   33s passing, and 20s FAILING when the fix is removed
    // So the universal pack costs about 21 extra seconds and is the only one of
    // the two that can tell the difference. That is the whole argument.
    //
    // --dir deliberately, not a full dmg/zip: the merge is what carries the risk,
    // and building installers on top of it adds minutes without adding coverage.
    // --universal is a macOS concept; elsewhere it is not a valid arch and the
    // pack would fail for a reason that has nothing to do with this app. The
    // verdict below names which pack actually ran, so a single-arch run on
    // another platform cannot be mistaken for universal coverage.
    const universal = process.platform === 'darwin';
    const packArgs = universal
      ? ['electron-builder', '--dir', '--universal', '-c.mac.identity=null']
      : ['electron-builder', '--dir'];
    console.log(`check-packaged-natives: packing (electron-builder ${packArgs.slice(1).join(' ')})…`);
    try {
      execFileSync('npx', packArgs, { cwd: root, stdio: 'inherit' });
    } catch (e) {
      console.error('check-packaged-natives: FAILED — electron-builder could not produce a universal bundle.');
      console.error('  If the error above is @electron/universal refusing a file that is "the same in both');
      console.error('  x64 and arm64 builds", declare it in mac.x64ArchFiles (AEON-1624). A single-arch');
      console.error('  pack would have passed this, which is exactly why this gate packs universal now.');
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

  failures += checkSidecars(packDirs);

  if (failures > 0) { console.error(`\ncheck-packaged-natives: ${failures} required file(s) MISSING from the bundle`); return 1; }
  // Say WHICH pack was certified. "all present" over a single-arch pack is a
  // narrower claim than the same sentence over a universal one, and the reader
  // acts on this line (AEON-1612/1623, same lesson).
  const scope = skipPack
    ? 'the existing dist/ build'
    : (process.platform === 'darwin' ? 'a UNIVERSAL pack (x64 + arm64 merged)' : `a single-arch pack (${process.platform})`);
  console.log(`\ncheck-packaged-natives: all native modules and sidecars present in ${scope}`);
  return 0;
}

if (require.main === module) process.exit(main());
