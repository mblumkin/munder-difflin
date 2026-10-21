import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkerProcess {
  pid: number;
  ppid: number;
  started: string;
  command: string;
}

/** Read ancestry before killing the PTY; children can be reparented on exit. */
export function processSnapshot(): WorkerProcess[] | null {
  if (process.platform === 'win32') return null;
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command='], { timeout: 2_000 });
  if (result.error || result.status !== 0) return null;
  return parseProcessSnapshot(String(result.stdout));
}

export function parseProcessSnapshot(output: string): WorkerProcess[] | null {
  const rows: WorkerProcess[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    if (!match) return null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] });
  }
  return rows;
}

export function descendantsOf(rows: WorkerProcess[], rootPid: number): WorkerProcess[] {
  const result: WorkerProcess[] = [];
  const seen = new Set([rootPid]);
  for (let i = 0, parents = [rootPid]; i < parents.length; i++) {
    for (const row of rows) {
      if (row.ppid === parents[i] && !seen.has(row.pid)) {
        seen.add(row.pid);
        parents.push(row.pid);
        result.push(row);
      }
    }
  }
  return result;
}

/** The wait flag is meaningful only on a live descendant launcher, not a log or echo. */
export function isQueueWait(rows: WorkerProcess[]): boolean {
  return rows.some(row => /^(?:\S*\/(?:ba|z|)sh|bash|sh|zsh)\s+(?:\S*\/)?(?:browser-run|gate-launch)\.sh\s+.*--wait-for-lock(?:=\S+|\s|$)/.test(row.command));
}

/** A live command a tool started: Claude Code's Bash tool runs `zsh -c source <snapshot> && eval ...` and Codex runs
 *  `bash -lc <cmd>`, so a shell with -c under the worker is work in flight, foreground or background (AEON-2473: a
 *  worker waiting 20 min on its own background command was reaped with its report unsent). A queue wait is one case.
 *  shortcut: a command that never exits (a dev server left running) keeps the worker forever, like a queue wait does;
 *  add a ceiling if a worker ever holds a slot that way. */
export function isToolCommand(rows: WorkerProcess[]): boolean {
  return isQueueWait(rows) || rows.some(row => /^(?:\S*\/)?(?:ba|z|da|)sh\s+-l?c\s/.test(row.command));
}

export function signalDescendants(
  rows: WorkerProcess[], signal: (pid: number, signal: NodeJS.Signals) => void = process.kill
): void {
  // Leaf first: a shell's TERM trap can finish after its foreground wait is stopped.
  for (const row of [...rows].reverse()) {
    try { signal(row.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

export function forceRemainingDescendants(rows: WorkerProcess[]): void {
  const current = processSnapshot();
  if (!current) return; // cannot safely target a possibly recycled PID
  const started = new Map(current.map(row => [row.pid, row.started]));
  for (const row of rows) {
    if (started.get(row.pid) !== row.started) continue;
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}

/** A queued launcher can already have been detached from the PTY. Its ticket
 *  still names the worker and the live owner PID, so capture it before reap. */
export function workerQueueOwners(
  hiveRoot: string | null, workerId: string, spawnedAt: number,
  rows: WorkerProcess[] | null = processSnapshot()
): WorkerProcess[] {
  if (!rows || !hiveRoot || !/^worker-[A-Za-z0-9._-]+$/.test(workerId)) return [];
  const dir = join(hiveRoot, 'locks', 'gate-queue');
  if (!existsSync(dir)) return [];
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const found = new Map<number, WorkerProcess>();
  for (const name of readdirSync(dir)) {
    if (!/\.(?:ticket|probe|release)$/.test(name)) continue;
    try {
      const path = join(dir, name);
      if (!lstatSync(path).isFile()) continue;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      if (!lines.includes(`agent=${workerId}`)) continue;
      const at = lines.find(line => line.startsWith('at='));
      const pid = lines.find(line => /^pid=\d+$/.test(line));
      const writtenAt = at ? Date.parse(at.slice(3)) : NaN;
      if (!Number.isFinite(writtenAt) || writtenAt + 1000 < spawnedAt || !pid) continue;
      const owner = byPid.get(Number(pid.slice(4)));
      if (owner) found.set(owner.pid, owner);
    } catch { /* concurrently settled or unreadable */ }
  }
  return [...found.values()];
}

/** Queue files name their owner; remove only this worker's tickets after its
 *  captured descendants have been stopped. A stale ticket otherwise holds FIFO. */
export function releaseWorkerQueueTickets(hiveRoot: string | null, workerId: string, reapedAt: number): number {
  if (!hiveRoot || !/^worker-[A-Za-z0-9._-]+$/.test(workerId)) return 0;
  const dir = join(hiveRoot, 'locks', 'gate-queue');
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.(?:ticket|probe|release)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      const data = readFileSync(path, 'utf8');
      const lines = data.split(/\r?\n/);
      const at = lines.find(line => line.startsWith('at='));
      const pidLine = lines.find(line => line.startsWith('pid='));
      const writtenAt = at ? Date.parse(at.slice(3)) : NaN;
      const ownerPid = pidLine && /^pid=\d+$/.test(pidLine) ? Number(pidLine.slice(4)) : NaN;
      // A new incarnation can use the same worker id before this timer fires.
      if (lines.includes(`agent=${workerId}`) && Number.isFinite(writtenAt) && writtenAt <= reapedAt
          && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); continue; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
        unlinkSync(path);
        removed++;
      }
    } catch { /* concurrently settled or unreadable; leave for queue scanner */ }
  }
  return removed;
}
