import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Never delete a worker directory containing Git-tracked evidence. Unknown
 *  Git status also preserves it; scratch GC is optional, evidence is not. */
export function removeWorkerScratchIfSafe(hiveRoot: string, workerId: string): 'tracked' | 'removed' | 'unknown' {
  if (!/^worker-[A-Za-z0-9._-]+$/.test(workerId)) return 'unknown';
  const agentsRoot = join(hiveRoot, 'agents');
  const dir = join(agentsRoot, workerId);
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir))) return 'unknown';
  if (!existsSync(dir)) return 'removed';
  const result = spawnSync('git', ['-C', hiveRoot, 'ls-files', '--cached', '-z', '--', `agents/${workerId}/`],
    { timeout: 3_000 });
  if (result.error || result.status !== 0) return 'unknown';
  if (result.stdout.length > 0) return 'tracked';
  rmSync(dir, { recursive: true, force: true });
  return 'removed';
}
