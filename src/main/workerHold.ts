import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A bounded, current hive hold prevents an otherwise idle worker from being reaped. */
export function shouldReapIdleWorker(
  hiveRoot: string | null, workerId: string, spawnedAt: number,
  idleMs: number, timeoutMs: number, now = Date.now()
): boolean {
  if (idleMs <= timeoutMs) return false;
  if (!hiveRoot || !/^worker-[A-Za-z0-9._-]+$/.test(workerId)) return true;
  try {
    const hold = JSON.parse(readFileSync(join(hiveRoot, 'agents', workerId, 'parked.json'), 'utf8')) as {
      holder?: unknown; reason?: unknown; since?: unknown; expected_by?: unknown;
    };
    if (hold.holder !== workerId || typeof hold.reason !== 'string' || !hold.reason.trim()) return true;
    const since = Date.parse(String(hold.since ?? ''));
    const expectedBy = Date.parse(String(hold.expected_by ?? ''));
    // hold.sh stamps seconds, while spawnedAt has milliseconds. A prior worker's
    // persisted marker must not protect a reused id after a new spawn.
    if (!Number.isFinite(since) || since + 1000 <= spawnedAt || since > now + 120_000) return true;
    if (!Number.isFinite(expectedBy) || expectedBy < since || now > expectedBy + 120_000) return true;
    return false;
  } catch {
    return true; // absent or malformed marker cannot establish a live hold
  }
}

/** Shares of a worker's token cap at which it is told to hand off (AEON-3837). */
export const TOKEN_CAP_NOTICE_PCTS = [85, 95] as const;

/**
 * The token-cap notice a worker is due this tick, or null. `sent` holds the
 * thresholds already noticed and is updated in place, so each threshold is
 * noticed once; a jump past both sends one notice, at the higher one.
 */
export function tokenCapNoticeDue(used: number, cap: number, sent: number[]): number | null {
  if (!(cap > 0)) return null;
  const crossed = TOKEN_CAP_NOTICE_PCTS.filter((p) => used >= cap * p / 100 && !sent.includes(p));
  if (crossed.length === 0) return null;
  sent.push(...crossed);
  return crossed[crossed.length - 1];
}

export function tokenCapNoticeText(pct: number, used: number, cap: number): { subject: string; body: string } {
  return {
    subject: `Token cap ${pct}%: write HANDOFF.md now`,
    body: `You have used ${used.toLocaleString('en-US')} of your ${cap.toLocaleString('en-US')} token cap (${pct}%). `
      + 'The harness reaps you without further warning when you pass the cap. '
      + 'Now: write wip/HANDOFF.md in your agent folder (what is done, what is not, where every uncommitted change is), '
      + 'commit it with bin/hive-commit.sh, commit and push your branch, inform god, then stop.'
  };
}
