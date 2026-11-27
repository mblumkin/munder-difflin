import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AEON-3837 (scope v2): a worker is never reaped at its token cap with unsaved
 * work. Notices at 70% and 90%; at the cap the worker enters WRAP with a grace
 * allowance, is reaped as soon as the wrap check passes, and on grace exhaustion
 * its dirty tree and unpushed tip are saved to refs/wip/<id>/<stamp> first.
 */

export const CAP_NOTICE_PCTS = [70, 90] as const;
export const WRAP_GRACE_MS = 20 * 60_000;
export const WRAP_GRACE_MIN_TOKENS = 1_000_000;

export interface CapState {
  sent: number[];
  wrapSince?: number;      // epoch ms the worker entered WRAP
  wrapUsedAt?: number;     // its token count then
  busy?: boolean;          // a wrap check or autosave is in flight
  done?: boolean;          // reaped (or reap issued)
}

export interface CapNotice { subject: string; body: string }

export interface CapTickDeps {
  /** Files an inform in the worker's inbox. */
  notify(n: CapNotice): void;
  /** True when the wrap check passes (see wrapCheck). */
  check(): Promise<boolean>;
  /** Saves dirty tree and unpushed tip; returns the refs written. */
  autosave(): Promise<string[]>;
  /** Kills the worker; `why` is 'wrapped' or 'grace-exhausted'; refs are the autosave refs. */
  reap(why: 'wrapped' | 'grace-exhausted', refs: string[]): void;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function graceTokens(cap: number): number {
  return Math.max(Math.round(cap * 0.1), WRAP_GRACE_MIN_TOKENS);
}

function noticeText(pct: number, used: number, cap: number): CapNotice {
  return {
    subject: `Token cap ${pct}%: wrap as you go`,
    body: `You have used ${fmt(used)} of your ${fmt(cap)} token cap (${pct}%). At the cap you get a short grace to wrap, then you are stopped. `
      + 'Now: commit and push your branch, write wip/HANDOFF.md in your agent folder (what is done, what is not, where every change is), '
      + 'commit it with bin/hive-commit.sh, and inform god naming HANDOFF.md.'
  };
}

function wrapText(used: number, cap: number, now: number): CapNotice {
  return {
    subject: 'Token cap reached: wrap now',
    body: `You have used ${fmt(used)} tokens, past your ${fmt(cap)} cap. You are in WRAP: you have ${fmt(graceTokens(cap))} more tokens `
      + `or until ${new Date(now + WRAP_GRACE_MS).toISOString()}, whichever ends first. You are stopped as soon as your tracked files are committed, `
      + 'your commits are pushed, and you have sent your done or an inform naming HANDOFF.md. '
      + 'If grace runs out first, the app saves your uncommitted changes and unpushed tip to refs/wip/ and stops you.'
  };
}

/**
 * One worker-tick step for a capped worker. Synchronous for notices and state;
 * the wrap check and autosave run in the background, guarded by `state.busy`.
 * Returns the promise of any background work so a test can await it.
 */
export function capTick(state: CapState, used: number, cap: number, now: number, deps: CapTickDeps): Promise<void> | null {
  if (!(cap > 0) || state.done) return null;
  const crossed = CAP_NOTICE_PCTS.filter((p) => used >= cap * p / 100 && !state.sent.includes(p));
  if (crossed.length > 0) {
    state.sent.push(...crossed);
    if (used <= cap) deps.notify(noticeText(crossed[crossed.length - 1], used, cap));
  }
  if (used <= cap) return null;
  if (state.wrapSince === undefined) {
    state.wrapSince = now;
    state.wrapUsedAt = used;
    deps.notify(wrapText(used, cap, now));
  }
  if (state.busy) return null;
  const exhausted = now - state.wrapSince >= WRAP_GRACE_MS || used - (state.wrapUsedAt ?? used) >= graceTokens(cap);
  state.busy = true;
  return (async () => {
    try {
      if (await deps.check().catch(() => false)) {
        state.done = true;
        deps.reap('wrapped', []);
      } else if (exhausted) {
        const refs = await deps.autosave().catch(() => []);
        state.done = true;
        deps.reap('grace-exhausted', refs);
      }
    } finally {
      state.busy = false;
    }
  })();
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '').trim() });
    });
  });
}

/** Commits on HEAD that are on no remote-tracking ref and not on the base. */
async function unpushed(worktree: string, baseBranch: string): Promise<string | null> {
  const r = await git(worktree, ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes', baseBranch]);
  if (!r.ok) return null;
  return r.out;
}

/** The worker sent an inform naming HANDOFF.md at or after `since`. */
export function sentHandoffInform(hiveRoot: string, workerId: string, since: number): boolean {
  const base = join(hiveRoot, 'agents', workerId, 'outbox');
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { act?: unknown; subject?: unknown; body?: unknown; created_at?: unknown };
        if (m.act !== 'inform') continue;
        const at = Date.parse(String(m.created_at ?? ''));
        if (Number.isFinite(at) && at < since) continue;
        if (/HANDOFF\.md/.test(`${m.subject ?? ''}\n${m.body ?? ''}`)) return true;
      } catch { /* unreadable message: not evidence */ }
    }
  }
  return false;
}

/**
 * The wrap check: (a) no modified tracked files, (b) no local commit off every
 * remote-tracking ref and the base, (c) a done or a HANDOFF.md inform was sent.
 * Any git failure fails the check, so doubt never reaps early.
 */
export async function wrapCheck(worktree: string, baseBranch: string, sentWrapSignal: () => boolean): Promise<boolean> {
  const st = await git(worktree, ['status', '--porcelain', '--untracked-files=no']);
  if (!st.ok || st.out !== '') return false;
  const ahead = await unpushed(worktree, baseBranch);
  if (ahead === null || ahead !== '') return false;
  return sentWrapSignal();
}

/**
 * Saves the dirty tree (a `git stash create` commit: the worktree and the stash
 * list are untouched) and the unpushed tip as local refs under
 * refs/wip/<workerId>/<stamp>/. Local refs live in the shared repo, so they
 * survive the worktree's removal. Never pushes.
 */
export async function autosaveWip(worktree: string, baseBranch: string, workerId: string, now: number): Promise<string[]> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const prefix = `refs/wip/${workerId}/${stamp}`;
  const refs: string[] = [];
  const stash = await git(worktree, ['stash', 'create', `autosave ${workerId} at token cap`]);
  if (stash.ok && /^[0-9a-f]{40}$/.test(stash.out)) {
    if ((await git(worktree, ['update-ref', `${prefix}/tree`, stash.out])).ok) refs.push(`${prefix}/tree`);
  }
  const ahead = await unpushed(worktree, baseBranch);
  if (ahead) {
    const tip = await git(worktree, ['rev-parse', 'HEAD']);
    if (tip.ok && (await git(worktree, ['update-ref', `${prefix}/tip`, tip.out])).ok) refs.push(`${prefix}/tip`);
  }
  return refs;
}

/** The sentence the token-cap reap notice to god carries about the wrap. */
export function capReapDetail(why: 'wrapped' | 'grace-exhausted', refs: string[], worktree: string | undefined): string {
  if (refs.length > 0) {
    return ` Grace ran out before it wrapped; its uncommitted changes and unpushed tip were saved in ${worktree ?? 'its repo'} as ${refs.join(', ')} (local refs, never pushed).`;
  }
  return why === 'wrapped' ? ' It wrapped first: tree clean, commits pushed, done or HANDOFF inform sent.' : ' Grace ran out before it wrapped; there was nothing unsaved to autosave.';
}
