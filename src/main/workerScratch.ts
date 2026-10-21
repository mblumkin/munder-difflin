import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Where a released worker's hive folder goes: outside agents/, which hive scripts iterate as live agents. */
export const ARCHIVED_AGENTS_DIR = 'archived-agents';

export interface ScratchArchive { result: 'tracked' | 'archived' | 'unknown'; to?: string }

/** Move a released worker's hive folder (inbox, outbox, memory, and any wip or patch it delivered) out of agents/
 *  into <hive>/archived-agents/<id>-<time>/. Never deletes (AEON-2507: deleting it took worker-w2492's delivered,
 *  not yet applied 2496 patch). A folder with Git-tracked evidence stays where it is, and unknown Git status
 *  also leaves it in place.
 *  shortcut: the archive is never pruned; add a retention sweep if it grows past what a disk can carry. */
export function archiveWorkerScratchIfSafe(hiveRoot: string, workerId: string, now = Date.now()): ScratchArchive {
  if (!/^worker-[A-Za-z0-9._-]+$/.test(workerId)) return { result: 'unknown' };
  const agentsRoot = join(hiveRoot, 'agents');
  const dir = join(agentsRoot, workerId);
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir))) return { result: 'unknown' };
  if (!existsSync(dir)) return { result: 'archived' };
  const result = spawnSync('git', ['-C', hiveRoot, 'ls-files', '--cached', '-z', '--', `agents/${workerId}/`],
    { timeout: 3_000 });
  if (result.error || result.status !== 0) return { result: 'unknown' };
  if (result.stdout.length > 0) return { result: 'tracked' };
  const archive = join(hiveRoot, ARCHIVED_AGENTS_DIR);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  let to = join(archive, `${workerId}-${stamp}`);
  try {
    mkdirSync(archive, { recursive: true });
    // Nothing archived is ever committed or mined: the hive's own git and mempalace both honour this file.
    if (!existsSync(join(archive, '.gitignore'))) writeFileSync(join(archive, '.gitignore'), '*\n');
    for (let n = 2; existsSync(to); n++) to = join(archive, `${workerId}-${stamp}-${n}`);
    renameSync(dir, to);
  } catch {
    return { result: 'unknown' };
  }
  return { result: 'archived', to };
}
