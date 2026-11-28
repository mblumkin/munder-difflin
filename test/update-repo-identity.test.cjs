'use strict';

/**
 * AEON-3841: the updater asks THIS fork, and a fork with no installers is quiet.
 *
 * Until 0.5.33 every update request named the upstream project: electron-builder.yml's
 * publish block (stamped into app-update.yml, which electron-updater reads), the
 * updater's own REPO, and the renderer's release links. Upstream's releases are a
 * different product line whose version numbers collide with ours, so a release there
 * could be offered to a fork install, and every "What's new" lookup asked upstream
 * for our tag.
 *
 * The fork publishes tags, not installers. Its releases feed lists the tags, so
 * electron-updater finds a newest tag, then no latest-mac.yml under it
 * (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND). That is the normal state here, so it must
 * not reach the badge as "update check failed" every 6 hours.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const updateState = loadTs('src/shared/updateState.ts');

test('the update repo is the fork', () => {
  assert.equal(updateState.REPO, 'mblumkin/munder-difflin');
});

test('electron-builder publish names the same repo the app asks', () => {
  const yml = read('electron-builder.yml');
  const block = /^publish:\n((?:[ \t]+.*\n?)+)/m.exec(yml);
  assert.ok(block, 'electron-builder.yml has a publish block');
  const owner = /^\s+owner:\s*(\S+)/m.exec(block[1])?.[1];
  const repo = /^\s+repo:\s*(\S+)/m.exec(block[1])?.[1];
  assert.equal(`${owner}/${repo}`, updateState.REPO);
});

test('no source file names another munder-difflin repo', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|cjs|js)$/.test(e.name)) {
        for (const m of read(rel).matchAll(/([A-Za-z0-9-]+)\/munder-difflin\b/g)) {
          if (m[1] !== 'mblumkin') hits.push(`${rel}: ${m[0]}`);
        }
      }
    }
  };
  walk('src');
  assert.deepEqual(hits, []);
});

test('a repo with nothing to install is a no-release state, not an error', () => {
  const { isNoReleaseError } = updateState;
  assert.equal(typeof isNoReleaseError, 'function');
  const coded = (code, message = 'x') => Object.assign(new Error(message), { code });
  // The fork today: tags in the feed, no channel file under the newest one.
  assert.equal(isNoReleaseError(coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/mblumkin/munder-difflin/releases/download/v0.5.31/latest-mac.yml): HttpError: 404')), true);
  assert.equal(isNoReleaseError(coded('ERR_UPDATER_NO_PUBLISHED_VERSIONS')), true);
  assert.equal(isNoReleaseError(coded('ERR_UPDATER_LATEST_VERSION_NOT_FOUND')), true);
  // An empty feed: the XML helper throws its own code with this message.
  assert.equal(isNoReleaseError(coded('ERR_XML_MISSED_ELEMENT', 'No published versions on GitHub')), true);
  // Real failures stay loud.
  assert.equal(isNoReleaseError(coded('ERR_XML_MISSED_ELEMENT', 'No element "link"')), false);
  assert.equal(isNoReleaseError(coded('ERR_UPDATER_INVALID_RELEASE_FEED')), false);
  assert.equal(isNoReleaseError(coded('ECONNRESET', 'socket hang up')), false);
  assert.equal(isNoReleaseError(new Error('update check timed out after 30s')), false);
  assert.equal(isNoReleaseError(null), false);
  assert.equal(isNoReleaseError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'), false);
});

test('no-release replaces checking, never a staged update, and reads as current', () => {
  const { reduceStatus, describeUpdate } = updateState;
  assert.deepEqual(reduceStatus({ state: 'checking' }, { state: 'no-release' }), { state: 'no-release' });
  const staged = { state: 'downloaded', version: '0.5.40' };
  assert.deepEqual(reduceStatus(staged, { state: 'no-release' }), staged);
  const view = describeUpdate({ state: 'no-release' }, '0.5.33');
  assert.notEqual(view.tone, 'warn');
  assert.equal(view.action, 'check');
  assert.equal(view.busy, false);
});

test('the updater routes both failure paths through isNoReleaseError', () => {
  const src = read('src/main/updater.ts');
  assert.doesNotMatch(src, /^const REPO\s*=/m, 'updater.ts takes REPO from shared/updateState');
  // runCheck's catch and the autoUpdater 'error' event: electron-updater reports a
  // failed check on both, so a guard on one alone still shows the error.
  assert.ok((src.match(/isNoReleaseError\(/g) || []).length >= 2, 'both failure paths check isNoReleaseError');
});
