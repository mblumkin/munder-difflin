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
  const notes: TaskBoardNotes<T> = { blocked: [], todo: [], doing: [], done: 0 };
  for (const t of tasks) {
    switch (t.status) {
      case 'blocked': notes.blocked.push('blocked'); break;
      case 'todo': notes.todo.push('todo'); break;
      case 'ready': notes.todo.push('ready'); break; // on the To Do board, in Ready's color (Mason, AEON-3397)
      case 'doing': notes.doing.push(t); break;
      case 'done': notes.done++; break;
      case 'backlog': break; // Backlog stays off the floor (Mason, AEON-3397)
      default: break; // cancelled, a card being carried, and anything else draw no note
    }
  }
  return notes;
}
