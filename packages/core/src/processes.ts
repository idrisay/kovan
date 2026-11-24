/**
 * Every coding agent running on this Mac — inside Kovan or not — and whether
 * it is still doing anything.
 *
 * This file only reads text: `ps` and `lsof` output in, a classification out.
 * Running those commands, finding each agent's log and sending signals is
 * main's job (`main/running.ts`).
 */

export type AgentKind = 'claude' | 'codex' | 'opencode';

/**
 * - `kovan`: under one of Kovan's own terminals.
 * - `terminal`: in any other terminal (it has a tty).
 * - `background`: no terminal, and not a known helper — a `claude -p` loop, say.
 * - `helper`: started and restarted by another app (VS Code's Codex server,
 *   Claude's Chrome bridge, an MCP server). Listed, never stopped from here.
 */
export type AgentGroup = 'kovan' | 'terminal' | 'background' | 'helper';

export type AgentState = 'working' | 'waiting' | 'idle';

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** When it started, epoch ms, to the second. */
  started: number;
  /** CPU seconds used so far. */
  cpu: number;
  /** Resident memory, KB. */
  rss: number;
  /** `ttys001`, or undefined for no terminal. */
  tty?: string;
  command: string;
}

export interface AgentPort {
  port: number;
  /** What is listening: `node`, `ruby`… */
  name: string;
}

export interface RunningAgent {
  /** `pid@start-second` — a pid alone can be reused by an unrelated program. */
  key: string;
  pid: number;
  kind: AgentKind;
  group: AgentGroup;
  title: string;
  /** The Kovan session it runs in, for `kovan` agents. */
  sessionId?: string;
  subject?: string;
  cwd?: string;
  /** `Terminal · ttys001`, `VS Code`, … */
  where?: string;
  command: string;
  startedAt: number;
  /** Last moment it was seen doing something; undefined until known. */
  lastActivity?: number;
  state: AgentState;
  /** Agent plus everything it started, KB. */
  memory: number;
  ports: AgentPort[];
  /** Names of what it started, ports excluded, at most a few. */
  children: string[];
  childCount: number;
}

export interface AgentsReport {
  at: number;
  idleMs: number;
  agents: RunningAgent[];
}

export const DEFAULT_IDLE_MINUTES = 60;

/** Reported as working for this long after the last sign of life. */
export const WORKING_MS = 90_000;

// --- ps ---------------------------------------------------------------------------------

/**
 * `ps -A -o pid=,ppid=,lstart=,time=,rss=,tty=,command=`, run with `LC_ALL=C`
 * — `lstart` is spelled in the user's locale otherwise. `lstart` rather than
 * `etime`: it is the same every scan, so a process keeps one key.
 */
// `-ww`: never cut the command line to a terminal's width. macOS's ps doesn't
// when its output is a pipe; Linux's procps can, and the agent is found by it.
export const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,time=,rss=,tty=,command='];

export function parsePs(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const started = Date.parse(match[3].replace(/\s+/g, ' '));
    const cpu = parseClock(match[4]);
    if (!Number.isFinite(started) || cpu === undefined) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started,
      cpu,
      rss: Number(match[5]),
      tty: match[6] === '??' || match[6] === '-' ? undefined : match[6],
      command: match[7].trim()
    });
  }
  return rows;
}

/** `[[dd-]hh:]mm:ss[.cc]` → seconds, as `time` prints CPU time. */
export function parseClock(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((v) => Number(v ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

// --- Classification ---------------------------------------------------------------------

const RUNTIMES = new Set(['node', 'bun', 'deno']);

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Which agent a command line is, if any. Looks through `node …/codex.js`. */
export function agentKind(command: string): AgentKind | undefined {
  const words = command.split(/\s+/);
  let exe = basename(words[0] ?? '');
  if (RUNTIMES.has(exe) && words[1]) exe = basename(words[1]).replace(/\.(c|m)?js$/, '');
  if (exe === 'claude' || exe === 'codex' || exe === 'opencode') return exe;
  // Codex's npm package runs a platform binary: `codex-aarch64-apple-darwin`.
  if (/^codex-(aarch64|x86_64)/.test(exe)) return 'codex';
  return undefined;
}

/** Started by another app on its own terms; stopping it only breaks that app. */
export function isHelperCommand(command: string): boolean {
  return /\s--chrome-native-host\b|\sapp-server\b|\smcp(\s+serve)?\b|\s--mcp\b/.test(` ${command}`);
}

/** `VS Code`, `Terminal`, `iTerm`… from the first `.app` bundle among the ancestors. */
export function hostApp(ancestors: string[]): string | undefined {
  for (const command of ancestors) {
    const bundle = /\/([^/]+)\.app\//.exec(command);
    if (bundle) return APP_NAMES[bundle[1]] ?? bundle[1];
    const exe = basename(command.split(/\s+/)[0] ?? '');
    if (exe === 'tmux' || exe === 'screen') return exe;
  }
  return undefined;
}

const APP_NAMES: Record<string, string> = {
  'Visual Studio Code': 'VS Code',
  'Visual Studio Code - Insiders': 'VS Code Insiders',
  iTerm2: 'iTerm',
  iTerm: 'iTerm',
  'Google Chrome': 'Chrome'
};

export type Tree = Map<number, ProcessRow[]>;

export function childrenOf(rows: ProcessRow[]): Tree {
  const tree: Tree = new Map();
  for (const row of rows) {
    const siblings = tree.get(row.ppid) ?? [];
    siblings.push(row);
    tree.set(row.ppid, siblings);
  }
  return tree;
}

export function descendantsOf(tree: Tree, pid: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const queue = [pid];
  while (queue.length > 0 && found.length < 1_000) {
    for (const child of tree.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Parent first, nearest first. Stops at launchd. */
export function ancestorsOf(byPid: Map<number, ProcessRow>, row: ProcessRow): ProcessRow[] {
  const found: ProcessRow[] = [];
  let next = byPid.get(row.ppid);
  while (next && next.pid > 1 && found.length < 64) {
    found.push(next);
    next = byPid.get(next.ppid);
  }
  return found;
}

export interface FoundAgent {
  row: ProcessRow;
  kind: AgentKind;
  ancestors: ProcessRow[];
  descendants: ProcessRow[];
}

/**
 * Every top-level agent. One started by another agent (a `codex exec` Claude
 * ran as a tool, or the native binary behind Codex's node wrapper) is part of
 * its parent, not a row of its own.
 *
 * `boundaries` are pids the nesting never looks past — Kovan's own terminal
 * shells. Kovan itself may have been started from an agent's terminal, and
 * what runs in its sessions is still its own agent, not part of that one.
 */
export function findAgents(rows: ProcessRow[], boundaries: ReadonlySet<number> = new Set()): FoundAgent[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const tree = childrenOf(rows);
  const found: FoundAgent[] = [];
  for (const row of rows) {
    const kind = agentKind(row.command);
    if (!kind) continue;
    const ancestors = ancestorsOf(byPid, row);
    const edge = ancestors.findIndex((a) => boundaries.has(a.pid));
    const within = edge >= 0 ? ancestors.slice(0, edge) : ancestors;
    if (within.some((a) => agentKind(a.command))) continue;
    found.push({ row, kind, ancestors, descendants: descendantsOf(tree, row.pid) });
  }
  return found;
}

export function processKey(row: ProcessRow): string {
  return `${row.pid}@${Math.round(row.started / 1000)}`;
}

/** Whether `row` is still the process `key` was taken from — same pid, same start. */
export function sameProcess(key: string, row: ProcessRow): boolean {
  return processKey(row) === key;
}

// --- lsof -------------------------------------------------------------------------------

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → listening ports by pid. */
export function parseListening(stdout: string): Map<number, AgentPort[]> {
  const ports = new Map<number, AgentPort[]>();
  let pid = 0;
  let name = '';
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value);
    else if (tag === 'c') name = value;
    else if (tag === 'n' && pid) {
      const port = Number(/:(\d+)$/.exec(value)?.[1]);
      if (!port) continue;
      const list = ports.get(pid) ?? [];
      if (!list.some((p) => p.port === port)) list.push({ port, name });
      ports.set(pid, list);
    }
  }
  return ports;
}

/** `lsof -a -d cwd -Fpn -p …` → working directory by pid. */
export function parseCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// --- State ------------------------------------------------------------------------------

export function agentState(lastActivity: number | undefined, now: number, idleMs: number): AgentState {
  if (lastActivity === undefined) return 'waiting';
  const quiet = now - lastActivity;
  if (quiet < WORKING_MS) return 'working';
  return quiet >= idleMs ? 'idle' : 'waiting';
}

/** `42s`, `4m`, `2h 10m`, `1d 3h`. */
export function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function formatMemory(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

/** Whether Stop is offered at all. */
export function stoppable(agent: Pick<RunningAgent, 'group'>): boolean {
  return agent.group !== 'helper';
}
