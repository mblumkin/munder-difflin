/**
 * Provider turn evidence for a seat (AEON-3709): did the seat's latest provider
 * turn fail? Mirrors hive bin/stall-check.py's FAILED-TURN read of Codex's own
 * thread history, so the app and the hive agree on what "fails every turn" means.
 */
import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/** The failure text when the latest turn of `threadId` failed and started at or
 *  after `sinceMs`, else null. Any read problem is "no evidence", never a failure. */
export function codexLatestTurnFailure(agentDir: string, threadId: string, sinceMs: number): string | null {
  try {
    const dir = join(agentDir, '.codex');
    const file = readdirSync(dir)
      .filter((f) => /^thread_history_.*\.sqlite$/.test(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!file) return null;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        'SELECT status, error_json, started_at FROM thread_turns WHERE thread_id = ? '
        + 'ORDER BY started_at DESC, rollout_ordinal DESC LIMIT 1'
      ).get(threadId) as { status: string; error_json: string | null; started_at: number | null } | undefined;
      // Codex stores started_at in epoch seconds.
      if (!row || row.status !== 'failed' || row.started_at == null || row.started_at * 1000 < sinceMs) return null;
      let code = 'failed turn';
      let message = '';
      try {
        const err = JSON.parse(row.error_json ?? '{}');
        message = String(err.message ?? '');
        const inner = JSON.parse(message)?.error;
        if (inner?.message) message = String(inner.message);
        code = String(inner?.code ?? err.codexErrorInfo ?? code);
      } catch { /* a non-JSON message is shown as it is */ }
      return `${code}: ${message}`.slice(0, 300);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
