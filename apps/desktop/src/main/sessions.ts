/**
 * Terminal sessions, and the agents running inside them.
 *
 * ## Why a pty and not a pipe
 *
 * Claude Code and Codex are alt-screen TUIs that check for a tty. A pipe will
 * not do — they refuse to draw. This is the same reason the Swift app carried
 * SwiftTerm rather than parsing output itself.
 *
 * ## Why the shell, and not the agent
 *
 * The session starts the user's **login shell** and types the agent's command
 * line into it, rather than spawning the agent directly. What that buys is a
 * session that outlives the agent: the scrollback stays, the directory stays,
 * and when the agent exits you are standing in a shell instead of looking at a
 * dead screen. It is also how a `-l` shell's profile — nvm, asdf, PATH — is
 * in force for the agent.
 *
 * The prompt never appears in that typed line; see `@baton/agent`'s
 * `shellLine`, which routes it through a file.
 */

import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import {
  loginShell,
  shellEnvironment,
  shellLine,
  type AgentRun,
  type Runner,
  type RunKind
} from '@baton/agent';
import { EventEmitter } from '@baton/host';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  runnerName: string;
  kind?: RunKind;
  subject?: string;
  startedAt: number;
  running: boolean;
  exitCode?: number;
  /** The run folder, when this session was started from a Run button. */
  runDirectory?: string;
}

interface Session extends SessionInfo {
  pty: IPty;
  /**
   * Everything written so far, so a reopened window can redraw a session it
   * was not present for. Capped — an agent that prints a megabyte of diff must
   * not grow the main process without bound.
   */
  buffer: string;
}

const BUFFER_LIMIT = 256 * 1024;

export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly output = new EventEmitter<{ id: string; data: string }>();
  private readonly changed = new EventEmitter<SessionInfo[]>();

  readonly onOutput = this.output.event;
  readonly onDidChange = this.changed.event;

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map(strip)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Replay for a window that opened after the session started. */
  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  /**
   * Opens a terminal, and optionally types one line into it.
   *
   * @param line what to run once the shell is up. Already-quoted by
   *             `shellLine` — this method must never build it.
   */
  async open(options: {
    cwd: string;
    title: string;
    runnerName: string;
    line?: string;
    env?: Record<string, string>;
    kind?: RunKind;
    subject?: string;
    runDirectory?: string;
  }): Promise<SessionInfo> {
    const id = randomUUID();
    // The environment a login shell produces, not the four-entry PATH a GUI
    // launch inherits. Without this the agent cannot find its own tools.
    const base = await shellEnvironment.environment();

    const pty = spawn(loginShell(), ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd: options.cwd,
      env: {
        ...base,
        ...options.env,
        TERM: 'xterm-256color',
        // Tells a prompt or a wrapper that it is inside Baton, the way
        // TERM_PROGRAM does for other terminals.
        TERM_PROGRAM: 'Baton'
      }
    });

    const session: Session = {
      id,
      title: options.title,
      cwd: options.cwd,
      runnerName: options.runnerName,
      kind: options.kind,
      subject: options.subject,
      runDirectory: options.runDirectory,
      startedAt: Date.now(),
      running: true,
      pty,
      buffer: ''
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT);
      this.output.fire({ id, data });
    });

    pty.onExit(({ exitCode }) => {
      session.running = false;
      session.exitCode = exitCode;
      this.changed.fire(this.list());
    });

    if (options.line) {
      // A beat for the shell to finish sourcing its profile. Typing into it
      // mid-rc gets the line echoed into a half-initialised prompt and, with
      // some frameworks, swallowed entirely.
      setTimeout(() => pty.write(`${options.line}\r`), 250);
    }

    this.changed.fire(this.list());
    return strip(session);
  }

  /** Starts an agent on a piece of work, filing it as a run. */
  async run(options: {
    runner: Runner;
    prompt: string;
    cwd: string;
    title: string;
    run: AgentRun;
    env: Record<string, string>;
  }): Promise<SessionInfo | { error: string }> {
    const line =
      options.runner.invocation === 'loginShell'
        ? undefined
        : await shellLine(options.runner, options.prompt);

    if (options.runner.invocation !== 'loginShell' && !line) {
      // The single most likely setup failure, and it deserves a real message
      // rather than a terminal that opens and immediately dies.
      return {
        error: `Could not find "${options.runner.command}" on your PATH or among your shell functions. Open a terminal and check it runs there.`
      };
    }

    return this.open({
      cwd: options.cwd,
      title: options.title,
      runnerName: options.runner.name,
      line,
      env: options.env,
      kind: options.run.kind,
      subject: options.run.subject,
      runDirectory: options.run.directory
    });
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.running) {
      try {
        session.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
      } catch {
        // The pty can exit between the check and the call.
      }
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.running) {
      try {
        session.pty.kill();
      } catch {
        // Already gone.
      }
    }
    this.sessions.delete(id);
    this.changed.fire(this.list());
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
    this.output.dispose();
    this.changed.dispose();
  }
}

function strip(session: Session): SessionInfo {
  const { pty, buffer, ...info } = session;
  void pty;
  void buffer;
  return info;
}
