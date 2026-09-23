/**
 * Every coding agent running on this Mac, and a safe way to stop the ones
 * you forgot.
 *
 * ## Finding them
 *
 * One `ps` of the whole machine, classified by `@baton/core`'s `findAgents`.
 * An agent under one of Baton's own terminals belongs to that session; one
 * with a tty is in some other terminal; one started by another app (VS Code's
 * Codex server, Claude's Chrome bridge) is a helper, listed but never stopped.
 * Quick-model jobs run under Baton itself and are listed from their own log,
 * not from here.
 *
 * ## Idle or working
 *
 * An agent's own log says when it last did something: Claude Code's
 * transcript, Codex's session log. Both are the files token usage already
 * reads. CPU between two scans covers anything with no log.
 *
 * ## Stopping
 *
 * Ctrl-C first — `SIGINT`, twice, the way you would at the keyboard — then
 * `SIGTERM` for the agent and everything it started, then nothing: whatever
 * is left is reported, and `SIGKILL` only follows a click. Every signal is
 * sent only after checking that the pid still belongs to the process it was
 * read from, so a pid the OS has since reused is never touched.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Notification } from 'electron';
import {
  DEFAULT_IDLE_MINUTES,
  PS_ARGS,
  agentState,
  descendantsOf,
  childrenOf,
  findAgents,
  formatIdle,
  formatMemory,
  hostApp,
  isHelperCommand,
  parseCwds,
  parseListening,
  parsePs,
  processKey,
  sameProcess,
  type AgentGroup,
  type AgentPort,
  type AgentsReport,
  type ProcessRow,
  type RunningAgent
} from '@baton/core';
import type { DesktopHost } from './host';
import type { Sessions, SessionInfo } from './sessions';
import { claudeConfigDirs, claudeTranscript, findCodexLog } from './usage';

const SLOW_MS = 60_000;
const FAST_MS = 5_000;
const PORTS_MS = 15_000;
/** Agent CPU share between scans above which it counts as busy. */
const BUSY_SHARE = 0.05;
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'caffeinate']);

export interface StopOutcome {
  key: string;
  stopped: boolean;
  /** Processes still running after SIGTERM — what Force stop would kill. */
  left: number;
}

interface Target {
  key: string;
  pid: number;
}

export class RunningAgents {
  private report: AgentsReport = { at: 0, idleMs: DEFAULT_IDLE_MINUTES * 60_000, agents: [] };
  private listener?: (report: AgentsReport) => void;
  private slow?: NodeJS.Timeout;
  private fast?: NodeJS.Timeout;
  private watchers = 0;
  private scanning?: Promise<void>;

  private readonly cpu = new Map<string, { cpu: number; at: number }>();
  private readonly busy = new Map<string, number>();
  private readonly firstSeen = new Map<string, number>();
  private readonly cwds = new Map<string, string>();
  private readonly codexLogs = new Map<string, string | null>();
  private ports = new Map<number, AgentPort[]>();
  private portsAt = 0;
  private readonly notified = new Set<string>();
  private readonly leftovers = new Map<string, Target[]>();

  constructor(
    private readonly host: DesktopHost,
    private readonly sessions: Sessions,
    private readonly onReminderClick: () => void
  ) {}

  onChange(listener: (report: AgentsReport) => void): void {
    this.listener = listener;
  }

  /** The background scan: once a minute, for the idle reminder and the sidebar count. */
  start(): void {
    this.slow = setInterval(() => void this.scan(), SLOW_MS);
    void this.scan();
  }

  dispose(): void {
    clearInterval(this.slow);
    clearInterval(this.fast);
  }

  current(): AgentsReport {
    return this.report;
  }

  /** The pane is open: scan every few seconds, ports included, until it closes. */
  watch(on: boolean): AgentsReport {
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
    clearInterval(this.fast);
    this.fast = undefined;
    if (this.watchers > 0) {
      this.fast = setInterval(() => void this.scan(), FAST_MS);
      this.portsAt = 0;
      void this.scan();
    }
    return this.report;
  }

  scan(): Promise<void> {
    // One at a time; a caller that arrives mid-scan waits for that one.
    this.scanning ??= this.doScan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    try {
      const now = Date.now();
      const rows = parsePs(await run('/bin/ps', PS_ARGS));
      if (rows.length === 0) return;
      const idleMs = Math.max(1, Number(this.host.config.get('agents.idleMinutes', DEFAULT_IDLE_MINUTES)) || DEFAULT_IDLE_MINUTES) * 60_000;
      const sessionsByPid = new Map(this.sessions.processes().map((p) => [p.pid, p.info]));

      const found = findAgents(rows, new Set(sessionsByPid.keys()))
        .map((agent) => ({ ...agent, key: processKey(agent.row) }))
        .map((agent) => ({ ...agent, session: agent.ancestors.map((a) => sessionsByPid.get(a.pid)).find(Boolean) }))
        // A quick-model job: under Baton, but not in one of its terminals.
        .filter((agent) => agent.session || !agent.ancestors.some((a) => a.pid === process.pid));

      await this.lookUpCwds(found.filter((a) => !this.cwds.has(a.key)).map((a) => ({ key: a.key, pid: a.row.pid })));
      if (this.watchers > 0 && now - this.portsAt >= PORTS_MS) {
        this.ports = parseListening(await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
        this.portsAt = now;
      }
      const configs = await claudeConfigDirs();

      const agents: RunningAgent[] = [];
      for (const agent of found) {
        const { row, kind, key, session } = agent;
        const protectedPids = this.protectedPids(rows, row.pid);
        const descendants = agent.descendants.filter((d) => !protectedPids.has(d.pid));
        const cwd = this.cwds.get(key);
        const group = groupOf(row, session, agent.ancestors);

        this.firstSeen.set(key, this.firstSeen.get(key) ?? now);
        const previous = this.cpu.get(key);
        if (previous && now > previous.at && (row.cpu - previous.cpu) / ((now - previous.at) / 1000) > BUSY_SHARE) {
          this.busy.set(key, now);
        }
        this.cpu.set(key, { cpu: row.cpu, at: now });

        const logged = await this.logActivity(kind, row, key, cwd, now, configs);
        const signs = [logged, this.busy.get(key)].filter((t): t is number => t !== undefined);
        const seen = this.firstSeen.get(key)!;
        // Nothing to go on yet: never "working" on no evidence, but count from
        // when Baton first saw it, so an agent with no log still turns idle
        // rather than waiting forever.
        const lastActivity = signs.length > 0 ? Math.max(...signs) : seen;
        let state = signs.length > 0 ? agentState(lastActivity, now, idleMs) : now - seen >= idleMs ? 'idle' : 'waiting';
        // The bell is the agent itself saying its turn is over.
        if (session?.attention && state === 'working') state = 'waiting';

        const ports: AgentPort[] = [];
        const children = new Set<string>();
        let childCount = 0;
        for (const d of [row, ...descendants]) {
          for (const port of this.ports.get(d.pid) ?? []) {
            if (!ports.some((p) => p.port === port.port)) ports.push(port);
          }
          if (d === row) continue;
          const name = exeName(d.command);
          if (SHELLS.has(name)) continue;
          childCount++;
          if (!this.ports.has(d.pid)) children.add(name);
        }

        agents.push({
          key,
          pid: row.pid,
          kind,
          group,
          title: session?.title ?? `${kind} in ${tilde(cwd) ?? 'an unknown folder'}`,
          sessionId: session?.id,
          subject: session?.subject,
          cwd,
          where: session ? undefined : [hostApp(agent.ancestors.map((a) => a.command)), row.tty].filter(Boolean).join(' · ') || undefined,
          command: row.command,
          startedAt: row.started,
          lastActivity,
          state,
          memory: row.rss + descendants.reduce((sum, d) => sum + d.rss, 0),
          ports: ports.sort((a, b) => a.port - b.port),
          children: [...children].slice(0, 3),
          childCount
        });
      }

      this.forget(new Set(agents.map((a) => a.key)));
      this.report = { at: now, idleMs, agents: agents.sort(order) };
      this.listener?.(this.report);
      this.remind(this.report);
    } catch (err) {
      this.host.log.warn(`running agents: scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * What stopping `agent` must never touch: Baton, what started it, and —
   * when Baton was itself launched from inside that agent's terminal — Baton's
   * own sessions. An agent inside a Baton terminal keeps everything it started.
   */
  private protectedPids(rows: ProcessRow[], agent: number): Set<number> {
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const pids = new Set<number>([0, 1, process.pid]);
    for (let row = byPid.get(process.pid); row && row.pid > 1; row = byPid.get(row.ppid)) pids.add(row.pid);
    const baton = descendantsOf(childrenOf(rows), process.pid).map((d) => d.pid);
    if (!baton.includes(agent)) for (const pid of baton) pids.add(pid);
    return pids;
  }

  private async lookUpCwds(missing: { key: string; pid: number }[]): Promise<void> {
    if (missing.length === 0) return;
    const cwds = parseCwds(await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', missing.map((m) => m.pid).join(',')]));
    for (const { key, pid } of missing) {
      const cwd = cwds.get(pid);
      if (cwd) this.cwds.set(key, cwd);
    }
  }

  /** When the agent's own log last moved. */
  private async logActivity(
    kind: RunningAgent['kind'], row: ProcessRow, key: string, cwd: string | undefined, now: number, configs: string[]
  ): Promise<number | undefined> {
    let file: string | undefined;
    if (kind === 'claude') {
      for (const config of configs) {
        file = await claudeTranscript(config, row.pid);
        if (file) break;
      }
    } else if (kind === 'codex' && cwd) {
      if (!this.codexLogs.has(key)) {
        this.codexLogs.set(key, (await findCodexLog(cwd, row.started, new Set())) ?? null);
      }
      file = this.codexLogs.get(key) ?? undefined;
    }
    if (!file) return undefined;
    return stat(file).then((s) => s.mtimeMs, () => undefined);
  }

  private forget(live: Set<string>): void {
    for (const map of [this.cpu, this.busy, this.firstSeen, this.cwds, this.codexLogs, this.leftovers]) {
      for (const key of map.keys()) if (!live.has(key)) map.delete(key);
    }
    for (const key of this.notified) if (!live.has(key)) this.notified.delete(key);
  }

  // --- Reminder ---------------------------------------------------------------------

  private remind(report: AgentsReport): void {
    const idle = report.agents.filter((a) => a.state === 'idle' && a.group !== 'helper');
    for (const key of this.notified) {
      if (!idle.some((a) => a.key === key)) this.notified.delete(key);
    }
    const fresh = idle.filter((a) => !this.notified.has(a.key));
    for (const agent of fresh) this.notified.add(agent.key);
    if (fresh.length === 0) return;
    if (!this.host.config.get('agents.remind', true) || !this.host.config.get('notify.enabled', true)) return;
    if (process.env['BATON_SMOKE'] || !Notification.isSupported()) return;

    const threshold = formatIdle(report.idleMs);
    const memory = formatMemory(idle.reduce((sum, a) => sum + a.memory, 0));
    const notification = new Notification(
      idle.length === 1
        ? { title: 'An agent is idle', body: `${idle[0].title} has done nothing for over ${threshold} · ${memory}` }
        : { title: `${idle.length} agents are idle`, body: `Nothing from them for over ${threshold} · ${memory} between them` }
    );
    notification.on('click', () => this.onReminderClick());
    notification.show();
  }

  // --- Stopping ---------------------------------------------------------------------

  async stop(keys: string[], children: boolean): Promise<StopOutcome[]> {
    const outcomes = await Promise.all(keys.map((key) => this.stopOne(key, children)));
    await this.scan();
    return outcomes;
  }

  private async stopOne(key: string, children: boolean): Promise<StopOutcome> {
    const listed = this.report.agents.find((a) => a.key === key);
    if (!listed || listed.group === 'helper') return { key, stopped: false, left: 0 };

    const now = Date.now();
    const rows = parsePs(await run('/bin/ps', PS_ARGS));
    const row = rows.find((r) => r.pid === listed.pid);
    if (!row || !sameProcess(key, row)) return { key, stopped: true, left: 0 };

    const protectedPids = this.protectedPids(rows, row.pid);
    if (protectedPids.has(row.pid)) return { key, stopped: false, left: 1 };
    // Taken now, while the tree is intact: once the agent exits, what it
    // started is reparented to launchd and no longer traceable to it.
    const targets: Target[] = [row, ...(children ? descendantsOf(childrenOf(rows), row.pid) : [])]
      .filter((r) => !protectedPids.has(r.pid))
      .map((r) => ({ key: processKey(r), pid: r.pid }));
    const agent = targets[0];

    await signal([agent], 'SIGINT');
    await sleep(1_500);
    await signal([agent], 'SIGINT');
    await sleep(2_500);
    await signal(targets, 'SIGTERM');
    await sleep(3_000);

    const left = await alive(targets);
    if (left.length > 0) this.leftovers.set(key, left);
    else this.leftovers.delete(key);
    return { key, stopped: !left.some((t) => t.pid === agent.pid), left: left.length };
  }

  /** SIGKILL, only for what a Stop left behind, and only after a click. */
  async forceStop(key: string): Promise<StopOutcome> {
    const left = this.leftovers.get(key) ?? [];
    await signal(left, 'SIGKILL');
    await sleep(500);
    const still = await alive(left);
    this.leftovers.delete(key);
    await this.scan();
    return { key, stopped: still.length === 0, left: still.length };
  }
}

function groupOf(row: ProcessRow, session: SessionInfo | undefined, ancestors: ProcessRow[]): AgentGroup {
  if (session) return 'baton';
  if (isHelperCommand(row.command)) return 'helper';
  if (row.tty) return 'terminal';
  // No terminal, but another app started it: that app's to manage.
  return hostApp(ancestors.map((a) => a.command)) ? 'helper' : 'background';
}

function order(a: RunningAgent, b: RunningAgent): number {
  return (a.lastActivity ?? a.startedAt) - (b.lastActivity ?? b.startedAt);
}

/** Only the processes that are still the ones the targets were taken from. */
async function alive(targets: Target[]): Promise<Target[]> {
  if (targets.length === 0) return [];
  const rows = new Map(parsePs(await run('/bin/ps', PS_ARGS)).map((r) => [r.pid, r]));
  return targets.filter((t) => {
    const row = rows.get(t.pid);
    return row !== undefined && sameProcess(t.key, row);
  });
}

async function signal(targets: Target[], name: NodeJS.Signals): Promise<void> {
  for (const target of await alive(targets)) {
    try {
      process.kill(target.pid, name);
    } catch {
      // Exited between the check and the signal.
    }
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // lsof exits 1 when one of several pids has gone; what it did print is still right.
    execFile(file, args, { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exeName(command: string): string {
  const first = command.split(/\s+/)[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1);
  const second = command.split(/\s+/)[1];
  if ((name === 'node' || name === 'python3' || name === 'python' || name === 'ruby') && second && !second.startsWith('-')) {
    return second.slice(second.lastIndexOf('/') + 1);
  }
  return name;
}

function tilde(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const home = homedir();
  return cwd === home ? '~' : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}
