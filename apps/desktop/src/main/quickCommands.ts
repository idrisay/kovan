/**
 * Quick commands (improvements item 91): stored in settings, run in a
 * terminal session of their own.
 *
 * The renderer never hands main a command line to run: it saves a command
 * (validated here, like any settings write) and then asks for one to be run
 * **by id**. That keeps the rule every other channel follows — a path or a
 * command that reaches a shell comes from Baton's own store, not from the
 * page — and it means a command is always exactly what you saw in the menu.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyName, normalizeQuickCommands, validateQuickCommand, type QuickCommand } from '@baton/core';
import type { DesktopHost } from './host';
import type { Sessions } from './sessions';

const KEY = 'quickCommands';
const LAST = 'quickCommands.last';

export class QuickCommands {
  constructor(private readonly host: DesktopHost, private readonly sessions: Sessions) {}

  list(): { commands: QuickCommand[]; last: string; busy: string[] } {
    const commands = normalizeQuickCommands(this.host.config.get<unknown>(KEY, []));
    const last = this.host.config.get<string>(LAST, '');
    // Still doing something, not just an open terminal at a prompt.
    const busy = this.sessions.list()
      .filter((s) => s.commandId && s.running && this.sessions.busy(s.id))
      .map((s) => s.commandId!);
    return { commands, last: commands.some((c) => c.id === last) ? last : commands[0]?.id ?? '', busy };
  }

  /** Adds (no id) or replaces (an existing id) one command. */
  async save(input: { id?: unknown; name?: unknown; command?: unknown; cwd?: unknown }): Promise<
    { ok: true; id: string } | { ok: false; error: string }
  > {
    const checked = validateQuickCommand(input);
    if (!checked.ok) return checked;
    const { commands } = this.list();
    const id = typeof input.id === 'string' && commands.some((c) => c.id === input.id) ? input.id : randomUUID();
    const next = commands.some((c) => c.id === id)
      ? commands.map((c) => (c.id === id ? { id, ...checked.value } : c))
      : [...commands, { id, ...checked.value }];
    await this.host.config.set(KEY, next);
    return { ok: true, id };
  }

  async duplicate(id: string): Promise<string | undefined> {
    const { commands } = this.list();
    const at = commands.findIndex((c) => c.id === id);
    if (at < 0) return undefined;
    const copy = { ...commands[at]!, id: randomUUID(), name: copyName(commands[at]!.name, commands.map((c) => c.name)) };
    await this.host.config.set(KEY, [...commands.slice(0, at + 1), copy, ...commands.slice(at + 1)]);
    return copy.id;
  }

  async remove(id: string): Promise<void> {
    await this.host.config.set(KEY, this.list().commands.filter((c) => c.id !== id));
  }

  /**
   * Runs one, by id. If it's already running — a dev server, most likely —
   * that session is returned instead of starting a second copy on the same
   * port.
   */
  async run(id: string): Promise<{ ok: true; sessionId: string; reused: boolean } | { ok: false; error: string }> {
    // (The folder is checked only for a new terminal: an open one is already in it.)
    const command = this.list().commands.find((c) => c.id === id);
    if (!command) return { ok: false, error: 'That command no longer exists.' };
    await this.host.config.set(LAST, id);

    // Its terminal is still open. Still running (a dev server)? Go to it —
    // never a second copy on the same port. Back at the prompt (a one-off that
    // finished)? Run it again right there, instead of opening another tab.
    const open = this.sessions.list().find((s) => s.commandId === id && s.running);
    if (open) {
      if (!this.sessions.busy(open.id)) this.sessions.retype(open.id, command.command);
      return { ok: true, sessionId: open.id, reused: true };
    }

    const cwd = expandHome(command.cwd || os.homedir());
    const isDir = await stat(cwd).then((s) => s.isDirectory(), () => false);
    if (!isDir) return { ok: false, error: `The folder ${command.cwd} doesn't exist any more. Edit the command to change it.` };

    const session = await this.sessions.open({
      cwd,
      title: command.name,
      runnerName: 'Quick command',
      // Typed into a login shell, as you'd type it — it's your own command,
      // saved by you, so nothing is quoted or rewritten.
      line: command.command,
      commandId: id
    });
    return { ok: true, sessionId: session.id, reused: false };
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
