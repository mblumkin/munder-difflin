/** Statuses understood by every task-board surface. */
export const HIVE_TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'backlog'] as const;

export type HiveTaskStatus = (typeof HIVE_TASK_STATUSES)[number];

/** Keep unknown ledger values visible in Todo, while preserving recognized states. */
export function normalizeHiveTaskStatus(value: unknown): HiveTaskStatus {
  return typeof value === 'string' && (HIVE_TASK_STATUSES as readonly string[]).includes(value)
    ? value as HiveTaskStatus
    : 'todo';
}
