/** Which notes the office floor's task board shows for a set of cards. `blocked` and `todo` are
 *  the two corkboards, each entry a key into the theme's noteColors; `doing` holds the cards a
 *  worker takes to their desk; `done` counts the sheets on the archive table. */
export interface TaskBoardNotes<T> {
  blocked: string[];
  todo: string[];
  doing: T[];
  done: number;
}

export function taskBoardNotes<T extends { status: string }>(tasks: T[]): TaskBoardNotes<T> {
  return {
    blocked: tasks.filter((t) => t.status === 'blocked').map(() => 'blocked'),
    todo: tasks.filter((t) => t.status === 'todo').map(() => 'todo'),
    doing: tasks.filter((t) => t.status === 'doing'),
    done: tasks.filter((t) => t.status === 'done').length
  };
}
