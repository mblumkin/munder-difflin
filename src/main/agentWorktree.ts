import { removeWorktree, worktreeHasUnintegratedWork } from './git';
import { linkWorktreeDeps, unlinkWorktreeDeps } from './worktreeDeps';

/**
 * What happens to a NORMAL agent's isolated worktree when its terminal ends (AEON-3843).
 *
 * Every ending reaches teardownPty: a crash (the PTY's own exit), a circuit-breaker
 * stop, a person's Stop or Restart (pty:kill), a voice kill. Until 0.5.33 each of them
 * ran `git worktree remove --force` here, which deleted whatever the agent had not
 * committed. A looping agent stopped by the breaker is the likeliest of all to be mid
 * edit, and a Restart comes straight back expecting the folder.
 *
 * Commits are safe on the agent/<id> branch, so only a DIRTY tree is kept, and a tree
 * git cannot read counts as dirty: an unknown is not a no. Workers have their own gate
 * (finalizeWorkerWorktree in index.ts) and never come here.
 *
 * No Electron import, so the test drives it against a real repository.
 */
export interface AgentWorktreeOutcome {
  fate: 'removed' | 'kept' | 'remove-failed';
  detail: string;
}

export async function finalizeAgentWorktree(wtPath: string, origCwd: string): Promise<AgentWorktreeOutcome> {
  // The linked node_modules is ours, not the agent's work, and git lists the link as
  // untracked: take it out before asking, or every tree with dependencies reads dirty.
  const unlinked = await unlinkWorktreeDeps(origCwd, wtPath);
  // 'HEAD' as the base: commits ahead do not matter here, only the working tree.
  const work = await worktreeHasUnintegratedWork(wtPath, 'HEAD');
  if (work.dirty) {
    // The next move is usually a Restart into this folder, so it should still run.
    if (unlinked.ok && unlinked.removed) await linkWorktreeDeps(origCwd, wtPath);
    return { fate: 'kept', detail: work.detail };
  }
  const r = await removeWorktree(origCwd, wtPath);
  return r.ok ? { fate: 'removed', detail: work.detail } : { fate: 'remove-failed', detail: r.error ?? 'unknown' };
}
