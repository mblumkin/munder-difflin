import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';

export type DepLink =
  | { ok: true; skipped: boolean; installed?: true }
  | { ok: false; error: string };

export type InstallDeps = (worktreeDir: string) => Promise<{ ok: true } | { ok: false; error: string }>;

type LockPackages = Record<string, { version?: string; optional?: boolean }>;

function lockPackages(file: string): LockPackages | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { packages?: LockPackages };
    return parsed.packages ?? null;
  } catch {
    return null;
  }
}

/** AEON-3751: whether `nodeModules` (via npm's hidden node_modules/.package-lock.json)
 *  holds what `lockFile` asks for. Optional entries may be absent (other platforms'
 *  binaries), but anything installed must be the locked version. */
export function depsMatchLock(nodeModules: string, lockFile: string): boolean {
  const wanted = lockPackages(lockFile);
  const installed = lockPackages(join(nodeModules, '.package-lock.json'));
  if (!wanted || !installed) return false;
  for (const [key, meta] of Object.entries(wanted)) {
    if (key === '') continue;
    const have = installed[key];
    if (!have) {
      if (meta.optional) continue;
      return false;
    }
    if (have.version !== meta.version) return false;
  }
  return true;
}

/** --ignore-scripts skips postinstall (munder-difflin's tools/ensure-pty-perms.cjs), so
 *  node-pty's prebuilt spawn-helper keeps mode 644 and every pty spawn fails with
 *  "posix_spawnp failed". Restore +x on each copy node-pty's loader may pick. */
export function restorePtyHelpers(nodeModules: string): void {
  if (process.platform === 'win32') return;
  const root = join(nodeModules, 'node-pty');
  const dirs = [join(root, 'build', 'Release'), join(root, 'build', 'Debug')];
  for (const base of [join(root, 'prebuilds'), join(root, 'bin')]) {
    try { for (const entry of readdirSync(base)) dirs.push(join(base, entry)); } catch { /* absent */ }
  }
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper');
    try { chmodSync(helper, statSync(helper).mode | 0o111); } catch { /* absent or not ours */ }
  }
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** `npm ci --ignore-scripts` inside the worktree only: never the base checkout. */
export const npmCiIgnoreScripts: InstallDeps = (worktreeDir) => new Promise((done) => {
  let tail = '';
  const keep = (d: Buffer): void => { tail = (tail + d.toString()).slice(-2000); };
  const proc = spawn(resolveCommand('npm'), ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: worktreeDir,
    env: { ...process.env, PATH: userShellPath() },
    timeout: INSTALL_TIMEOUT_MS
  });
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  proc.on('error', (err) => done({ ok: false, error: String(err) }));
  proc.on('close', (code, signal) => {
    if (code === 0) done({ ok: true });
    else done({ ok: false, error: `npm ci exited ${code ?? signal}: ${tail.trim()}` });
  });
});

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** Link the base checkout's dependencies into an isolated worktree. When the
 *  worktree has a package-lock.json the base's node_modules does not satisfy
 *  (empty, or installed from another lockfile), install into the worktree instead:
 *  a link to stale deps runs no test (AEON-3751). */
export async function linkWorktreeDeps(
  baseDir: string,
  worktreeDir: string,
  install: InstallDeps = npmCiIgnoreScripts
): Promise<DepLink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  const lockFile = join(worktreeDir, 'package-lock.json');
  if (!existsSync(baseNodeModules) && !existsSync(lockFile)) return { ok: true, skipped: true };

  try {
    await lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
    // node_modules does not exist in this worktree yet.
  }

  if (existsSync(lockFile) && !depsMatchLock(baseNodeModules, lockFile)) {
    const res = await install(worktreeDir);
    if (res.ok) {
      restorePtyHelpers(worktreeNodeModules);
      return { ok: true, skipped: false, installed: true };
    }
    return {
      ok: false,
      error: `${baseNodeModules} does not match ${lockFile} and installing into the worktree failed `
        + `(run npm ci --ignore-scripts there by hand): ${res.error}`
    };
  }

  try {
    await symlink(baseNodeModules, worktreeNodeModules, process.platform === 'win32' ? 'junction' : null);
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Remove the dependency link before testing whether a worktree is dirty. */
export async function unlinkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepUnlink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');

  try {
    const stat = await lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      realpath(baseNodeModules),
      realpath(resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}
