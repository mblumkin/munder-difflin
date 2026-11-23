import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** What the spawn watcher kept about a hiring, read back from its archived spawn request. */
export interface WorkerHiring {
  reqId: string;
  name: string;
  cwd: string;
  slack?: { channel: string; thread_ts: string };
  spawnedAt: number;
  tokenCap?: number;
}

/** The id processSpawnRequest gives a request: its "id" field, else its file name, made path-safe. */
export function spawnReqId(raw: { id?: unknown }, fileName: string): string {
  return (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fileName.replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
}

/** AEON-3764: the hiring behind a worker whose card the renderer restored after an app restart, or null when it was
 *  never hired through spawn-requests. A reused id overwrites its archived request, but one with its own "id" field
 *  sits under a different file name, so the newest match wins. spawnedAt is the request's write time (an archive
 *  rename keeps it): before this hiring's done, and after any earlier hiring's, since a live id refuses a new one. */
export function findWorkerHiring(doneDir: string, workerId: string): WorkerHiring | null {
  let files: string[];
  try { files = readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best: WorkerHiring | null = null;
  for (const f of files) {
    const fp = join(doneDir, f);
    let raw: { id?: unknown; name?: unknown; cwd?: unknown; slack?: { channel?: unknown; thread_ts?: unknown }; tokenCap?: unknown };
    let spawnedAt: number;
    try {
      raw = JSON.parse(readFileSync(fp, 'utf8'));
      spawnedAt = statSync(fp).mtimeMs;
    } catch { continue; }
    if (!raw || typeof raw !== 'object') continue;
    const reqId = spawnReqId(raw, f);
    if (`worker-${reqId}` !== workerId || (best && best.spawnedAt >= spawnedAt)) continue;
    const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
      ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
    best = {
      reqId,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      slack,
      spawnedAt,
      tokenCap: typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0 ? raw.tokenCap : undefined
    };
  }
  return best;
}
