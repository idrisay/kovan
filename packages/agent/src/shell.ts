/**
 * What this machine's shell knows, ported from `DevHubKit/ShellEnvironment.swift`.
 *
 * The problem it solves: a GUI-launched app inherits a four-entry PATH that
 * contains none of the places coding agents install to. Asking the user's login
 * shell what *its* environment is, and spawning into that, is the difference
 * between the app seeing your agents and the app insisting you have none.
 */

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `command` | `function` | `alias` | `none` — what `whence -w` reports. */
export type CommandKind = 'command' | 'function' | 'alias' | 'builtin' | 'none';

const MARKER = '__baton_env_marker__';

/** The user's real login shell, not whatever spawned this process. */
export function loginShell(): string {
  try {
    const shell = userInfo().shell;
    if (shell && shell.length > 0) {
      return shell;
    }
  } catch {
    // userInfo() can throw on odd container setups.
  }
  return process.env['SHELL'] ?? '/bin/zsh';
}

/**
 * What may appear in a command name.
 *
 * This is the one field that gets interpolated into a shell script (see
 * `Runner.shellLine`), so it is the one field that has to be checked. Real
 * command names are a small alphabet and nothing legitimate is excluded.
 */
export function isSafeCommandName(name: string): boolean {
  // The type says string; the callers include settings and discovery output,
  // so this has been handed `undefined` in practice. It is a safety check —
  // it answers "no" rather than throwing.
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[\p{L}\p{N}_\-.:+@]+$/u.test(name)
  );
}

export class ShellEnvironment {
  private env?: Record<string, string>;
  private readonly described = new Map<string, CommandKind>();

  /**
   * The environment a login shell produces.
   *
   * `-l -c` and a marker line: rc files print banners, version managers print
   * warnings, and everything before the marker is somebody's `.zshrc` being
   * chatty. stdin is /dev/null so an interactive-ish rc cannot sit waiting.
   */
  async environment(): Promise<Record<string, string>> {
    if (this.env) {
      return this.env;
    }
    try {
      const { stdout } = await run(loginShell(), ['-l', '-c', `echo ${MARKER}; printenv`], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000
      });
      const lines = stdout.split('\n');
      // `endsWith` rather than `===`: rc output with no trailing newline leaves
      // the marker glued to the end of a banner.
      const start = lines.findLastIndex((line) => line.endsWith(MARKER));
      const parsed: Record<string, string> = {};
      if (start >= 0) {
        for (const line of lines.slice(start + 1)) {
          const eq = line.indexOf('=');
          if (eq > 0) {
            parsed[line.slice(0, eq)] = line.slice(eq + 1);
          }
        }
      }
      this.env = Object.keys(parsed).length > 0 ? parsed : { ...process.env } as Record<string, string>;
    } catch {
      this.env = { ...process.env } as Record<string, string>;
    }
    return this.env;
  }

  /** Forget everything — for when somebody installs an agent mid-session. */
  invalidate(): void {
    this.env = undefined;
    this.described.clear();
  }

  /** Absolute path of an executable on the *resolved* PATH, or undefined. */
  async which(command: string): Promise<string | undefined> {
    if (!isSafeCommandName(command)) {
      return undefined;
    }
    const env = await this.environment();
    for (const dir of (env['PATH'] ?? '').split(':')) {
      if (!dir) continue;
      const candidate = `${dir}/${command}`;
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Next entry.
      }
    }
    return undefined;
  }

  /**
   * Whether each name is a command, a function, an alias, or absent.
   *
   * `which` finds executables and nothing else. Shell functions and aliases do
   * not exist outside an interactive shell — they are lines in an rc file — so
   * a roster built only from PATH silently offers half the agents somebody has.
   * This is `whence -w` inside `-i -l`, which is the only context where those
   * definitions exist.
   */
  async describe(names: readonly string[]): Promise<Map<string, CommandKind>> {
    const wanted = names.filter(isSafeCommandName);
    const missing = wanted.filter((name) => !this.described.has(name));

    if (missing.length > 0) {
      const env = await this.environment();
      // Names go in as positional parameters and are never interpolated into
      // the script — the same rule Runner follows.
      const script =
        'for c in "$@"; do whence -w -- "$c" 2>/dev/null || echo "$c: none"; done';
      try {
        const { stdout } = await run(
          loginShell(),
          ['-i', '-l', '-c', script, 'baton', ...missing],
          { env, maxBuffer: 1024 * 1024, timeout: 15_000 }
        );
        for (const line of stdout.split('\n')) {
          const [name, kind] = line.split(':').map((s) => s.trim());
          if (name && kind) {
            this.described.set(name, normaliseKind(kind));
          }
        }
      } catch {
        // A shell that will not answer is not fatal; the PATH check below is
        // a second opinion that can still find things.
      }

      // Anything unanswered is absent, not unknown — otherwise every call
      // re-asks for the same nothing.
      for (const name of missing) {
        if (!this.described.has(name)) {
          this.described.set(name, 'none');
        }
      }

      // A second opinion, deliberately failing toward "found".
      //
      // These two mechanisms answer the same question and have disagreed
      // before. Being wrong costs asymmetrically: a false "absent" drops an
      // agent you use daily out of the picker entirely, while a false "present"
      // gets you a can't-start message that already exists. So an executable
      // sitting on the resolved PATH outranks a shell that said nothing.
      await Promise.all(
        missing
          .filter((name) => this.described.get(name) === 'none')
          .map(async (name) => {
            if (await this.which(name)) {
              this.described.set(name, 'command');
            }
          })
      );
    }

    return new Map(
      wanted.flatMap((name) => {
        const kind = this.described.get(name);
        return kind ? ([[name, kind]] as [string, CommandKind][]) : [];
      })
    );
  }

  /** Every function and alias the login shell defines, for discovery. */
  async definedNames(): Promise<string[]> {
    const env = await this.environment();
    try {
      const { stdout } = await run(
        loginShell(),
        ['-i', '-l', '-c', 'print -l ${(k)functions} ${(k)aliases} 2>/dev/null'],
        { env, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }
      );
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && isSafeCommandName(name));
    } catch {
      return [];
    }
  }
}

function normaliseKind(raw: string): CommandKind {
  const value = raw.toLowerCase();
  if (value.includes('function')) return 'function';
  if (value.includes('alias')) return 'alias';
  if (value.includes('builtin')) return 'builtin';
  if (value === 'none' || value.includes('not found')) return 'none';
  return 'command';
}

export const shellEnvironment = new ShellEnvironment();
