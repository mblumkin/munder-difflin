#!/usr/bin/env node
'use strict';
/**
 * Strip tunnelmole's self-dependency, re-applied on every install (postinstall).
 *
 * tunnelmole@2.4.0 lists ITSELF in its own dependencies ("tunnelmole": "^2.1.6").
 * app-builder-lib 26's NpmNodeModulesCollector._getNodeModules walks the
 * production dependency graph recursively with no visited set and no depth cap,
 * so that one self-edge never terminates: electron-builder 26.0.x dies with
 * "Maximum call stack size exceeded" and 26.6+ with a heap OOM, producing no
 * bundle at all. electron-builder 25 is unaffected because it used
 * app-builder-bin's native node-dep-tree instead of the in-heap TS collector.
 *
 * AEON-1617 proved this with one variable: same tree, same node_modules, same
 * already-built out/, electron-builder 26.15.3. Deleting only this line took the
 * pack from exit 134 (heap OOM) to exit 0. npm `overrides` cannot express
 * "remove this edge", which is why this is a patch script rather than config.
 *
 * FAIL CLOSED, on the AEON-1610 pattern. Every way of not-patching used to exit
 * 0 in that script's ancestor, including the dangerous one: a source whose
 * expected text no longer matches is indistinguishable from "already patched"
 * if you only test for the original. So "already done" is a POSITIVE
 * observation here (a marker this script writes), never the mere absence of the
 * self-dep. A future tunnelmole that drops the self-dependency on its own is
 * therefore a LOUD failure, not a silent no-op: that is good news worth acting
 * on, and the right response is to delete this script, not to let it sit in
 * postinstall doing nothing while everyone assumes it is still earning its
 * place.
 *
 * The check that actually goes red if this stops working is
 * `npm run test:packaging` — it packs a real app, which is the only thing that
 * observes the collector at all.
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const MARKER = '_munderDifflinSelfDepStripped';

/**
 * Decide what to do with a parsed tunnelmole package.json. Pure: no fs.
 * Returns { ok, out, action } where action is 'stripped' | 'already' | 'missing'.
 * ok is false only for 'missing' — the self-dep is gone and we never removed it.
 */
function planStrip(pkg) {
  if (pkg && pkg[MARKER]) {
    return { ok: true, out: pkg, action: 'already' };
  }
  if (pkg && pkg.dependencies && pkg.dependencies.tunnelmole !== undefined) {
    const out = { ...pkg, dependencies: { ...pkg.dependencies } };
    delete out.dependencies.tunnelmole;
    out[MARKER] = pkg.version || true;
    return { ok: true, out, action: 'stripped' };
  }
  return { ok: false, out: pkg, action: 'missing' };
}

function main() {
  const manifest = join(__dirname, '..', 'node_modules', 'tunnelmole', 'package.json');
  if (!existsSync(manifest)) {
    // tunnelmole is a production dependency (src/main/webhook.ts, src/main/slack.ts).
    // Its absence means the install is broken or restructured, not that there is
    // nothing to do.
    console.error(`[patch-tunnelmole-selfdep] FAILED: tunnelmole is missing at ${manifest}`);
    return 1;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (e) {
    console.error(`[patch-tunnelmole-selfdep] FAILED: could not parse ${manifest}: ${e.message}`);
    return 1;
  }

  const plan = planStrip(pkg);

  if (!plan.ok) {
    console.error('[patch-tunnelmole-selfdep] FAILED: tunnelmole no longer declares itself as a dependency,');
    console.error(`  and this script did not remove it (no ${MARKER} marker). Installed version: ${pkg.version}.`);
    console.error('  That is probably GOOD NEWS - upstream fixed it. Confirm with a real pack');
    console.error('  (npm run test:packaging) and then DELETE this script and its postinstall entry,');
    console.error('  rather than leaving it here doing nothing. See AEON-1617.');
    return 1;
  }

  if (plan.action === 'stripped') {
    writeFileSync(manifest, JSON.stringify(plan.out, null, 2) + '\n', 'utf8');
    console.log(`[patch-tunnelmole-selfdep] removed tunnelmole's self-dependency (${pkg.version})`);
  } else {
    console.log('[patch-tunnelmole-selfdep] already stripped, nothing to do');
  }
  return 0;
}

module.exports = { planStrip, MARKER };

if (require.main === module) process.exit(main());
