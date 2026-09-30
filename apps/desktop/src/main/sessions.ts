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

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loginShell,
  shellEnvironment,
  shellLine,
  type AgentRun,
  type Runner,
  type RunKind
} from '@baton/agent';
import { EventEmitter } from '@baton/host';
import { usefulTerminalTitle } from '@baton/core';
import { scanForBell, scanForTitles } from './bell';
import type { AgentState, StatusSource } from './agentStatus';
import { localPty, type Pty, type PtyHosts } from './ptyClient';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  runnerName: string;
  kind?: RunKind;
  subject?: string;
  /** The pull request a run was started from, when it was one. */
  pull?: string;
  startedAt: number;
  running: boolean;
  exitCode?: number;
  /** The run folder, when this session was started from a Run button. */
  runDirectory?: string;
  /**
   * Set the moment the pty rings the terminal bell (`\x07`) — the same signal
   * a CLI agent (Claude Code, Codex, opencode) sends when a turn finishes and
   * it is sitting idle on your reply, and the same one iTerm/tmux already
   * color a tab for. Cleared the moment you write back to the session, since
   * that is the actual "I saw it" signal, not a timer.
   */
  attention: boolean;
  /**
   * What the program in a plain terminal says it is doing — the title it sets,
   * as a VS Code terminal tab shows it ("Investigate ACME-2409"). The name
   * given at opening comes from the branch the clone was on then, and says
   * nothing once the work in it moves on. Never set on an agent run, whose
   * title already names its work, nor once somebody renamed the session.
   */
  task?: string;
  /** The quick command (item 91) this session is running, if it is one. */
  commandId?: string;
  /** Renamed by hand: the name is theirs and nothing retitles it. */
  renamed?: boolean;
  /**
   * What the agent says it is doing (item 112), for the agents that can say:
   * see `agentStatus.ts`. Unset for plain terminals and other runners, which
   * keep the bell's `attention`.
   */
  status?: AgentState;
  /** When `status` last changed, epoch ms — what "seen" is measured against. */
  statusAt?: number;
  statusSource?: StatusSource;
  /** Whether it lives in the terminal host and outlives Baton (item 114). */
  hosted?: boolean;
}

interface Session extends SessionInfo {
  pty: Pty;
  /** Carried between chunks: an OSC string can straddle two of them. */
  inOsc: boolean;
  /** An OSC title string split across two chunks. */
  titleCarry?: string;
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

  constructor(
    /** The ticket a program's title names, when it names one Baton knows. */
    private readonly ticketIn: (text: string) => string | undefined = () => undefined,
    private readonly options: {
      /** The terminal host (item 114); without it sessions end with Baton. */
      hosts?: PtyHosts;
      /** Where agents write their status (item 112), handed to every session. */
      statusDir?: string;
    } = {}
  ) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map(strip)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Tells the list, and each host what to give back to a restarted Baton.
   * Only on a real change — never per chunk of output.
   */
  private publish(): void {
    for (const session of this.sessions.values()) session.pty.describe(strip(session));
    this.changed.fire(this.list());
  }

  /** Each session's shell process id — what token usage walks down from to find its agents. */
  processes(): { info: SessionInfo; pid: number }[] {
    return [...this.sessions.values()].map((session) => ({ info: strip(session), pid: session.pty.pid }));
  }

  /** Replay for a window that opened after the session started. */
  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  /**
   * The sessions a terminal host kept while Baton was away (item 114), as
   * they were left: still running, or finished with their scrollback.
   */
  async restore(): Promise<number> {
    const restored = await this.options.hosts?.restore() ?? [];
    for (const r of restored) {
      const meta = r.meta as Partial<SessionInfo> | undefined;
      if (!meta?.id || this.sessions.has(meta.id)) continue;
      const session: Session = {
        ...(meta as SessionInfo),
        running: r.running,
        exitCode: r.exitCode,
        hosted: true,
        pty: r.pty,
        inOsc: false,
        buffer: r.buffer
      };
      this.sessions.set(session.id, session);
      this.attach(session);
    }
    if (restored.length) this.publish();
    return restored.length;
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
    pull?: string;
    runDirectory?: string;
    /** A quick command's id: its name is the session's, and stays. */
    commandId?: string;
    /** The agent in it reports Working / Input / Done (item 112). */
    statusSource?: StatusSource;
  }): Promise<SessionInfo> {
    const id = randomUUID();
    // The environment a login shell produces, not the four-entry PATH a GUI
    // launch inherits. Without this the agent cannot find its own tools.
    const base = await shellEnvironment.environment();

    const info: SessionInfo = {
      id,
      title: options.title,
      cwd: options.cwd,
      runnerName: options.runnerName,
      kind: options.kind,
      subject: options.subject,
      pull: options.pull,
      runDirectory: options.runDirectory,
      ...(options.commandId ? { commandId: options.commandId, renamed: true } : {}),
      ...(options.statusSource ? { statusSource: options.statusSource, status: 'working' as const, statusAt: Date.now() } : {}),
      startedAt: Date.now(),
      running: true,
      attention: false
    };
    const spawn = {
      id,
      file: loginShell(),
      args: ['-l'],
      cols: 120,
      rows: 34,
      cwd: options.cwd,
      env: {
        ...base,
        ...options.env,
        TERM: 'xterm-256color',
        // Tells a prompt or a wrapper that it is inside Baton, the way
        // TERM_PROGRAM does for other terminals.
        TERM_PROGRAM: 'Baton',
        // Which session an agent's status hook writes for (item 112).
        BATON_SESSION_ID: id,
        ...(this.options.statusDir ? { BATON_STATUS_DIR: this.options.statusDir } : {})
      },
      meta: info
    };
    const pty = this.options.hosts ? await this.options.hosts.spawn(spawn) : localPty(spawn);

    const session: Session = { ...info, hosted: pty.hosted, pty, inOsc: false, buffer: '' };
    this.sessions.set(id, session);
    this.attach(session);

    if (options.line) {
      // Waits for the shell's own startup output to go quiet, rather than a
      // fixed beat. A fixed delay was typed into the shell mid-rc on anything
      // slower to start than the guess — nvm, asdf, oh-my-zsh, a themed
      // prompt computing git status asynchronously — and depending on the
      // framework that line was echoed into a half-initialised prompt,
      // swallowed entirely, or left sitting typed but never submitted: the
      // exact "it does not run the process" this replaces.
      const line = options.line;
      let sent = false;
      let idle: NodeJS.Timeout;
      const settle = () => {
        if (sent) return;
        clearTimeout(idle);
        idle = setTimeout(send, 250);
      };
      const send = () => {
        if (sent) return;
        sent = true;
        clearTimeout(idle);
        clearTimeout(ceiling);
        pty.write(`${line}\r`);
      };
      // Nothing printed yet by a shell that shows its prompt without a word
      // of startup chatter — 600ms is that case's own settle, not a guess at
      // profile load time.
      idle = setTimeout(send, 600);
      // Whatever the profile does, it does not get forever.
      const ceiling = setTimeout(send, 4_000);
      pty.onData(settle);
    }

    this.publish();
    return strip(session);
  }

  /** Follows a session's output and its end, whether just opened or picked up again. */
  private attach(session: Session): void {
    session.pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT);
      const scan = scanForBell(data, session.inOsc);
      session.inOsc = scan.inOsc;
      // Only worth a `changed` broadcast on the transition — the list would
      // otherwise republish on every single chunk a busy agent prints.
      let changed = scan.bell && !session.attention;
      if (changed) session.attention = true;
      // Codex says when a turn ends, not when it stops for an approval; its
      // bell mid-turn is that stop (item 112).
      if (scan.bell && session.statusSource === 'codex' && session.status === 'working') {
        changed = this.setState(session, 'input') || changed;
      }
      if (!session.kind) changed = this.retitle(session, data) || changed;
      if (changed) this.publish();
      this.output.fire({ id: session.id, data });
    });

    session.pty.onExit(({ exitCode }) => {
      session.running = false;
      session.exitCode = exitCode;
      this.publish();
    });
  }

  /** What an agent's status hook wrote (item 112). */
  setStatus(id: string, state: AgentState): void {
    const session = this.sessions.get(id);
    if (session && this.setState(session, state)) this.publish();
  }

  private setState(session: Session, state: AgentState): boolean {
    if (session.status === state) return false;
    session.status = state;
    session.statusAt = Date.now();
    return true;
  }

  /** Starts an agent on a piece of work, filing it as a run. */
  async run(options: {
    runner: Runner;
    prompt: string;
    cwd: string;
    title: string;
    run: AgentRun;
    env: Record<string, string>;
    statusSource?: StatusSource;
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
      pull: options.run.pull || undefined,
      runDirectory: options.run.directory,
      statusSource: options.statusSource
    });
  }

  /** Follows the title the program sets. True when the row should redraw. */
  private retitle(session: Session, data: string): boolean {
    const scan = scanForTitles(data, session.titleCarry);
    session.titleCarry = scan.carry;
    if (session.renamed) return false;
    // Only the last one counts: a busy chunk can hold several frames of a spinner.
    const task = scan.titles.map(usefulTerminalTitle).filter(Boolean).pop();
    if (!task || task === session.task) return false;
    session.task = task;
    session.subject = this.ticketIn(task) ?? session.subject;
    return true;
  }

  /**
   * Whether something other than the shell itself is in the foreground —
   * a dev server, a test run — as opposed to a prompt waiting for input.
   * What a quick command (item 91) asks before starting itself again.
   */
  async busy(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session?.running) return false;
    const shell = path.basename(loginShell()).replace(/^-/, '');
    const foreground = (await session.pty.foreground()).replace(/^-/, '');
    return Boolean(foreground) && path.basename(foreground) !== shell;
  }

  /** Types a line into an idle session and runs it, as if typed. */
  retype(id: string, line: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.running) return false;
    session.pty.write(`${line}\r`);
    return true;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Typing back is the actual "I saw it" — clearer than a timer, and it is
    // the one action every one of these CLIs requires before it does anything
    // else, so it can never miss a real reply.
    let changed = false;
    if (session.attention) {
      session.attention = false;
      changed = true;
    }
    // Codex's reply or approval sets it going again; the others say so themselves.
    if (session.statusSource === 'codex' && session.status !== 'working' && data.includes('\r')) {
      changed = this.setState(session, 'working') || changed;
    }
    if (changed) this.publish();
    session.pty.write(data);
  }

  /** A session's title is just a label once set — renaming never touches
   *  `subject`, which is what the row's own click-to-navigate goes by. */
  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    const trimmed = title.trim();
    if (!session || !trimmed || trimmed === session.title) return;
    session.title = trimmed;
    session.renamed = true;
    session.task = undefined;
    this.publish();
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
    // A hosted session is also forgotten by its host, running or not.
    if (session.running || session.hosted) {
      try {
        session.pty.kill();
      } catch {
        // Already gone.
      }
    }
    this.sessions.delete(id);
    this.publish();
  }

  /** Ends every session — for tests, and a Baton with no terminal host. */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
    this.output.dispose();
    this.changed.dispose();
  }

  /**
   * Baton is quitting (item 114): sessions in the terminal host keep
   * running and come back on the next start; any that live inside Baton
   * (no host could be started) end with it.
   */
  detachAll(): void {
    for (const session of this.sessions.values()) {
      if (!session.hosted) try { session.pty.kill(); } catch { /* gone */ }
    }
    this.options.hosts?.detach();
    this.output.dispose();
    this.changed.dispose();
  }
}

function strip(session: Session): SessionInfo {
  const { pty, buffer, inOsc, titleCarry, ...info } = session;
  void pty;
  void buffer;
  void inOsc;
  void titleCarry;
  return info;
}
