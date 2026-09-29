/**
 * The run sheet's choices that come back next time (improvements item 94):
 * which folders a piece of work ran across, and where it started. Kept per
 * subject (a ticket or a pull request), with the last ticket's as the
 * starting point for a ticket that hasn't been run yet — tickets here usually
 * span the same backend and frontend.
 */

export interface FolderChoice {
  /** Where the agent starts. */
  cwd: string;
  /** The other folders it works across. */
  extras: string[];
  /** Epoch ms, for keeping only the most recent. */
  at: number;
}

export interface FolderMemory {
  bySubject: Record<string, FolderChoice>;
  /** The last one chosen for any ticket. */
  lastTicket?: FolderChoice;
}

/** How many subjects' folders are kept; the oldest go first. */
export const FOLDER_MEMORY_LIMIT = 50;

export function rememberFolders(
  memory: FolderMemory,
  subject: string,
  isTicket: boolean,
  choice: { cwd: string; extras: readonly string[] },
  now: number = Date.now()
): FolderMemory {
  if (!subject || !choice.cwd) return memory;
  const entry: FolderChoice = { cwd: choice.cwd, extras: [...new Set(choice.extras)].filter((p) => p !== choice.cwd), at: now };
  const bySubject = Object.fromEntries(
    Object.entries({ ...memory.bySubject, [subject]: entry })
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, FOLDER_MEMORY_LIMIT)
  );
  return { bySubject, ...(isTicket ? { lastTicket: entry } : memory.lastTicket ? { lastTicket: memory.lastTicket } : {}) };
}

/**
 * What to preselect for `subject`: its own last choice, else (for a ticket)
 * the last ticket's — only folders still offered, and only when the start
 * folder itself still is.
 */
export function recallFolders(
  memory: FolderMemory,
  subject: string,
  isTicket: boolean,
  offered: readonly string[]
): { cwd: string; extras: string[] } | undefined {
  const saved = memory.bySubject[subject] ?? (isTicket ? memory.lastTicket : undefined);
  if (!saved || !offered.includes(saved.cwd)) return undefined;
  return { cwd: saved.cwd, extras: saved.extras.filter((p) => offered.includes(p) && p !== saved.cwd) };
}

/** A stored memory back, trusting nothing. */
export function folderMemoryFrom(stored: unknown): FolderMemory {
  const valid = (v: unknown): v is FolderChoice => {
    const c = v as FolderChoice;
    return Boolean(c) && typeof c.cwd === 'string' && Boolean(c.cwd) && Array.isArray(c.extras) &&
      c.extras.every((p) => typeof p === 'string') && typeof c.at === 'number';
  };
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const bySubject = source['bySubject'] && typeof source['bySubject'] === 'object' ? (source['bySubject'] as Record<string, unknown>) : {};
  return {
    bySubject: Object.fromEntries(Object.entries(bySubject).filter(([, v]) => valid(v))) as Record<string, FolderChoice>,
    ...(valid(source['lastTicket']) ? { lastTicket: source['lastTicket'] } : {})
  };
}
