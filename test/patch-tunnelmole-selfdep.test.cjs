'use strict';
/**
 * AEON-1617: tunnelmole declares itself as a dependency, and app-builder-lib 26
 * walks the production graph with no visited set, so that one self-edge makes
 * electron-builder 26 unable to produce a bundle at all. The patcher removes the
 * edge; these cases pin its decision logic.
 *
 * The case that matters most is the last one. On the AEON-1610 pattern, "already
 * done" must be a positive observation rather than the absence of the thing we
 * remove — otherwise a future tunnelmole that fixes this upstream is
 * indistinguishable from a successful strip, and the script rots into a silent
 * no-op in postinstall while everyone assumes it is still doing something.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { planStrip, MARKER } = require('../tools/patch-tunnelmole-selfdep.cjs');

const SELF_DEP_MANIFEST = () => ({
  name: 'tunnelmole',
  version: '2.4.0',
  dependencies: { axios: '^1.7.7', tunnelmole: '^2.1.6', ws: '^8.18.0' },
});

test('a manifest carrying the self-dependency is stripped', () => {
  const r = planStrip(SELF_DEP_MANIFEST());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'stripped');
  assert.strictEqual(r.out.dependencies.tunnelmole, undefined);
});

test('stripping leaves every other dependency alone', () => {
  const r = planStrip(SELF_DEP_MANIFEST());
  assert.strictEqual(r.out.dependencies.axios, '^1.7.7');
  assert.strictEqual(r.out.dependencies.ws, '^8.18.0');
  assert.strictEqual(Object.keys(r.out.dependencies).length, 2);
});

test('stripping does not mutate the input', () => {
  const input = SELF_DEP_MANIFEST();
  planStrip(input);
  assert.strictEqual(input.dependencies.tunnelmole, '^2.1.6',
    'planStrip must be pure: postinstall reads the manifest once and the caller decides to write');
});

test('a stripped manifest records the marker', () => {
  const r = planStrip(SELF_DEP_MANIFEST());
  assert.strictEqual(r.out[MARKER], '2.4.0');
});

test('re-running over an already-stripped manifest is a no-op, not a failure', () => {
  const once = planStrip(SELF_DEP_MANIFEST());
  const twice = planStrip(once.out);
  assert.strictEqual(twice.ok, true);
  assert.strictEqual(twice.action, 'already');
});

test('a manifest with no self-dependency and no marker FAILS LOUDLY', () => {
  const upstreamFixed = { name: 'tunnelmole', version: '3.0.0', dependencies: { axios: '^1.7.7' } };
  const r = planStrip(upstreamFixed);
  assert.strictEqual(r.ok, false, 'an upstream fix must not look like a successful strip');
  assert.strictEqual(r.action, 'missing');
});

test('the marker alone is enough, even if a later tunnelmole reintroduces the edge', () => {
  // Ordering check: the marker is consulted before the dependency map, so a
  // manifest this script already wrote is never stripped twice or mis-read.
  const marked = { name: 'tunnelmole', version: '2.4.0', [MARKER]: '2.4.0', dependencies: {} };
  assert.strictEqual(planStrip(marked).action, 'already');
});

test('a manifest with no dependencies map at all fails rather than throwing', () => {
  const r = planStrip({ name: 'tunnelmole', version: '9.9.9' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.action, 'missing');
});
