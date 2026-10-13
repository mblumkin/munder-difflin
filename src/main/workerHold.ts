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
