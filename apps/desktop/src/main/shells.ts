/**
 * Which shell a new terminal opens in (item 126).
 *
 * The choices are the shells macOS itself lists in `/etc/shells` that are
 * actually installed, so fish or nu appear once installed and registered.
 * The renderer only ever sends back a path from this list, and a saved path
 * that is no longer listed falls back to the login shell, so nothing outside
 * that file is ever spawned. Agents are not affected: they keep the login
 * shell, whose rc files set up their tools.
 */
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { loginShell } from '@kovan/agent';

export interface ShellOption {
  path: string;
  /** What the switch shows: `zsh`, or `zsh (Homebrew)` / `zsh (macOS)` for the one that isn't the login shell. */
  name: string;
  login: boolean;
}

/** The setting the menu's switch and Settings › Text & terminal both write. */
export const SHELL_SETTING = 'terminal.shell';

/** Shells people reach for first, in the switch's order after the login shell. */
const COMMON = ['zsh', 'bash', 'sh', 'fish', 'nu'];

/** Reads `/etc/shells`' format: one absolute path per line, `#` comments. */
export function parseShells(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.startsWith('/'));
}

function installed(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The listed shells, login shell first, then the common ones, then the rest
 * by name. Two entries for the same binary (a symlink) count once; two
 * different binaries with one name (macOS's zsh and Homebrew's) are both
 * kept and told apart by where they live.
 */
export function orderShells(paths: string[], login: string, real: (p: string) => string = (p) => p): ShellOption[] {
  const seen = new Set<string>();
  const unique = paths.filter((p) => {
    const key = real(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.includes(login)) unique.unshift(login);
  const names = new Map<string, number>();
  for (const p of unique) names.set(path.basename(p), (names.get(path.basename(p)) ?? 0) + 1);
  // By the shown name, so a second zsh (Homebrew's) sorts with the rest.
  const rank = (s: ShellOption) => {
    if (s.login) return -1;
    const i = COMMON.indexOf(s.name);
    return i === -1 ? COMMON.length : i;
  };
  return unique
    .map((p) => {
      const base = path.basename(p);
      return { path: p, name: (names.get(base) ?? 0) > 1 ? twinName(p, login, unique) : base, login: p === login };
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * A name for one of two shells with the same name. The login shell keeps the
 * plain name (it is the one people mean by "zsh"); the other says where it is
 * from. With neither the login shell, macOS's own keeps the plain name.
 */
function twinName(p: string, login: string, all: string[]): string {
  const base = path.basename(p);
  const where = /^\/(opt\/homebrew|usr\/local)\//.test(p) ? 'Homebrew'
    : /^\/(bin|usr\/bin)\//.test(p) ? 'macOS'
      : path.dirname(p);
  if (p === login) return base;
  const loginTwin = path.basename(login) === base && all.includes(login);
  if (!loginTwin && where === 'macOS') return base;
  return `${base} (${where})`;
}

export function listShells(): ShellOption[] {
  let text = '';
  try {
    text = readFileSync('/etc/shells', 'utf8');
  } catch {
    // No such file: the login shell alone, as before item 126.
  }
  const real = (p: string) => {
    try { return realpathSync(p); } catch { return p; }
  };
  return orderShells(parseShells(text).filter(installed), loginShell(), real);
}

/** The shell to spawn for a saved choice: only a listed one, else the login shell. */
export function chosenShell(saved: unknown, shells: ShellOption[] = listShells()): string {
  const match = typeof saved === 'string' ? shells.find((s) => s.path === saved) : undefined;
  return match?.path ?? loginShell();
}
