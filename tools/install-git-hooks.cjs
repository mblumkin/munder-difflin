'use strict';
// AEON-2553: point git at the tracked tools/git-hooks (commit-msg requires an AEON id). Local config, so a clone
// never carries it; npm runs this on install. A worktree shares the clone's config. Never overwrites a value
// someone set on purpose, and never fails the install.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WANT = 'tools/git-hooks';
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const top = git('rev-parse', '--show-toplevel');
if (top === null) process.exit(0);
if (!fs.existsSync(path.join(top, WANT, 'commit-msg'))) process.exit(0);
const current = git('config', '--local', '--get', 'core.hooksPath');
if (current === WANT) process.exit(0);
if (current !== null) {
  console.warn(`install-git-hooks: core.hooksPath is '${current}', not '${WANT}'; leaving it. To use the fork's hooks: git config core.hooksPath ${WANT}`);
  process.exit(0);
}
if (git('config', '--local', 'core.hooksPath', WANT) === null) console.warn(`install-git-hooks: could not set core.hooksPath; set it by hand: git config core.hooksPath ${WANT}`);
else console.log(`install-git-hooks: core.hooksPath = ${WANT} (commit-msg requires an AEON id)`);
