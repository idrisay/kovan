/**
 * Quick commands (improvements item 91): your own shell commands, saved with
 * a name and run from the title bar in one click — "frontend dev",
 * "optimize", "run the tests" — each in its own terminal session. Like Orca's
 * quick commands, and item 6 ("Saved actions") in getbaton-features.md.
 *
 * The logic that doesn't need a process: what a valid command is, reading
 * back what's stored, and searching.
 */

export interface QuickCommand {
  id: string;
  /** What the button and the session are called: "frontend dev". */
  name: string;
  /** Typed into a login shell as if you'd typed it: `cd ~/app && npm run dev`. */
  command: string;
  /** Where the shell starts. Empty means your home folder. */
  cwd: string;
}

export const QUICK_COMMAND_LIMITS = { name: 60, command: 4_000 } as const;

/** Checks a command as typed in the editor. Says what's wrong in words. */
export function validateQuickCommand(input: { name?: unknown; command?: unknown; cwd?: unknown }):
  | { ok: true; value: Omit<QuickCommand, 'id'> }
  | { ok: false; error: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (!name) return { ok: false, error: 'Give it a name.' };
  if (name.length > QUICK_COMMAND_LIMITS.name) return { ok: false, error: `Keep the name under ${QUICK_COMMAND_LIMITS.name} characters.` };
  if (!command) return { ok: false, error: 'Type the command to run.' };
  if (command.length > QUICK_COMMAND_LIMITS.command) return { ok: false, error: 'That command is too long.' };
  if (cwd && !cwd.startsWith('/') && !cwd.startsWith('~')) return { ok: false, error: 'The folder must be a full path, like /Users/you/app.' };
  return { ok: true, value: { name, command, cwd } };
}

/**
 * Whatever is stored under `quickCommands`, as a clean list: anything that
 * isn't a valid command is dropped, and ids are unique.
 */
export function normalizeQuickCommands(stored: unknown): QuickCommand[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: QuickCommand[] = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue;
    const { id } = item as { id?: unknown };
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    const checked = validateQuickCommand(item as Record<string, unknown>);
    if (!checked.ok) continue;
    seen.add(id);
    out.push({ id, ...checked.value });
  }
  return out;
}

/**
 * The commands matching what's typed in the menu's search: every word must
 * appear in the name or the command. Name matches first, then the rest, each
 * in their saved order.
 */
export function filterQuickCommands(list: readonly QuickCommand[], query: string): QuickCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  const hits = list.filter((c) => words.every((w) => `${c.name} ${c.command}`.toLowerCase().includes(w)));
  const byName = hits.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
  return [...byName, ...hits.filter((c) => !byName.includes(c))];
}

/** "frontend dev (copy)", then "(copy 2)" — for Duplicate. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${base} (copy ${n})`;
  return candidate.slice(0, QUICK_COMMAND_LIMITS.name);
}
