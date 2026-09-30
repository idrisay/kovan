/**
 * Token usage per Kovan session, read from the agents' own logs.
 *
 * ## How a terminal is tied to its agent's log
 *
 * Claude Code writes `<config>/sessions/<pid>.json` for as long as it runs —
 * `<config>` being `~/.claude`, or `~/.claude-work` and the like for a wrapper
 * that sets `CLAUDE_CONFIG_DIR` — naming the transcript it is writing. So
 * every few seconds, while a terminal is open, this walks the processes under
 * that terminal's shell and asks each config folder about each pid. That is
 * exact: two sessions in the same folder never get each other's tokens, and
 * `/clear` or `--resume` only adds another transcript to the same session.
 *
 * Codex keeps no pid file, so a Codex log is claimed by folder and start time
 * — the first unclaimed log in the terminal's folder that started after the
 * terminal did — and only while a `codex` process is actually under it.
 *
 * Logs are read incrementally (from the last offset), so a long transcript is
 * read once, not every tick. The totals are kept in `usage.json`, so a
 * ticket's cost survives the sessions being closed and Kovan restarting.
 */

import { execFile } from 'node:child_process';
import { open, readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  ClaudeTranscript,
  CodexLog,
  QUICK_KIND_LABEL,
  codexSessionMeta,
  mergeModels,
  type ModelUsage,
  type QuickJob,
  type UsageRecord
} from '@kovan/core';
import type { DesktopHost } from './host';
import type { Sessions, SessionInfo } from './sessions';

const SCAN_MS = 15_000;
/** Enough history for "last 30 days" and every ticket still in flight. */
const RECORD_LIMIT = 3_000;

interface Reader {
  file: string;
  parser: ClaudeTranscript | CodexLog;
  offset: number;
}

interface Tracked {
  readers: Map<string, Reader>;
  /** When the Kovan session started: earlier transcript lines aren't its own. */
  since?: number;
  /** Stops one last read being repeated forever for a closed session. */
  finished: boolean;
}

export class Usage {
  private readonly file: string;
  private records = new Map<string, UsageRecord>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly loaded: Promise<void>;
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private listener?: (records: UsageRecord[]) => void;

  constructor(
    private readonly host: DesktopHost,
    private readonly sessions: Sessions,
    private readonly quickJobs: () => Promise<QuickJob[]>
  ) {
    this.file = path.join(host.files.stateDir(), 'usage.json');
    this.loaded = this.load();
  }

  onChange(listener: (records: UsageRecord[]) => void): void {
    this.listener = listener;
  }

  start(): void {
    this.sessions.onDidChange(() => void this.scan());
    this.timer = setInterval(() => void this.scan(), SCAN_MS);
    void this.scan();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Every session's record plus every quick job, newest first. */
  async list(): Promise<UsageRecord[]> {
    await this.loaded;
    const quick = (await this.quickJobs()).map(quickRecord);
    return [...this.records.values(), ...quick].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Tells the window, when the quick model's job log moved. */
  async quickChanged(): Promise<void> {
    this.listener?.(await this.list());
  }

  private async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as UsageRecord[];
      this.records = new Map(stored.map((r) => [r.id, r]));
    } catch {
      this.records = new Map();
    }
  }

  private async save(): Promise<void> {
    const kept = [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECORD_LIMIT);
    this.records = new Map(kept.map((r) => [r.id, r]));
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(kept), 'utf8');
  }

  // --- Scanning -------------------------------------------------------------------------

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.loaded;
      const processes = this.sessions.processes();
      const live = processes.filter((p) => p.info.running || !this.tracked.get(p.info.id)?.finished);
      if (live.length === 0) return;

      const tree = await processTree();
      const configs = await claudeConfigDirs();
      let changed = false;
      for (const { info, pid } of live) {
        const tracked = this.tracked.get(info.id) ?? { readers: new Map(), finished: false };
        this.tracked.set(info.id, tracked);
        if (info.running) await this.discover(info, descendants(tree, pid), configs, tracked);
        else tracked.finished = true;
        if (await this.read(info, tracked)) changed = true;
      }
      if (changed) {
        await this.save();
        this.listener?.(await this.list());
      }
    } catch (err) {
      this.host.log.warn(`usage scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async discover(
    info: SessionInfo,
    children: { pid: number; command: string }[],
    configs: string[],
    tracked: Tracked
  ): Promise<void> {
    for (const child of children) {
      for (const config of configs) {
        const transcript = await claudeTranscript(config, child.pid);
        if (transcript && !tracked.readers.has(transcript)) {
          tracked.readers.set(transcript, { file: transcript, parser: new ClaudeTranscript(sessionSince(info.startedAt)), offset: 0 });
          this.host.log.info(`usage: session ${info.id} → ${transcript}`);
        }
      }
    }
    if (children.some((c) => /(^|\/)codex\b/.test(c.command))) {
      const claimed = new Set([...this.tracked.values()].flatMap((t) => [...t.readers.keys()]));
      const log = await findCodexLog(info.cwd, info.startedAt, claimed);
      if (log) {
        tracked.readers.set(log, { file: log, parser: new CodexLog(), offset: 0 });
        this.host.log.info(`usage: session ${info.id} → ${log}`);
      }
    }
  }

  /** Reads whatever each log gained since last time; true when the totals moved. */
  private async read(info: SessionInfo, tracked: Tracked): Promise<boolean> {
    if (tracked.readers.size === 0) return false;
    // A Claude conversation's subagents write their own transcripts, in a
    // folder beside the conversation's (item 111). They are part of what the
    // session cost, and appear whenever the agent starts one.
    for (const reader of [...tracked.readers.values()]) {
      if (!(reader.parser instanceof ClaudeTranscript) || reader.file.includes(`${path.sep}subagents${path.sep}`)) continue;
      const folder = path.join(reader.file.replace(/\.jsonl$/, ''), 'subagents');
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        const file = path.join(folder, name);
        if (!name.endsWith('.jsonl') || tracked.readers.has(file)) continue;
        tracked.readers.set(file, { file, parser: new ClaudeTranscript(sessionSince(info.startedAt)), offset: 0 });
        this.host.log.info(`usage: session ${info.id} → subagent ${file}`);
      }
    }
    let grew = false;
    for (const reader of tracked.readers.values()) {
      const size = await stat(reader.file).then((s) => s.size).catch(() => -1);
      if (size < 0 || size === reader.offset) continue;
      if (size < reader.offset) {
        // Rewritten from scratch; start over rather than read garbage.
        reader.parser = reader.parser instanceof CodexLog ? new CodexLog() : new ClaudeTranscript(sessionSince(info.startedAt));
        reader.offset = 0;
      }
      const handle = await open(reader.file, 'r');
      try {
        const length = size - reader.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, reader.offset);
        reader.parser.feed(buffer.toString('utf8'));
        reader.offset = size;
        grew = true;
      } finally {
        await handle.close();
      }
    }
    if (!grew) return false;

    const models: ModelUsage[] = mergeModels([...tracked.readers.values()].map((r) => r.parser.models()));
    const previous = this.records.get(info.id);
    this.records.set(info.id, {
      id: info.id,
      title: info.title,
      subject: info.subject,
      pull: info.pull,
      kind: info.kind,
      runnerName: info.runnerName,
      source: [...tracked.readers.values()].some((r) => r.parser instanceof CodexLog) ? 'codex' : 'claude',
      startedAt: previous?.startedAt ?? info.startedAt,
      updatedAt: Date.now(),
      models,
      ...(conversationUsd(tracked) !== undefined ? { conversationUsd: conversationUsd(tracked)! } : {})
    });
    return true;
  }
}

/** A little before the session started: its first response can't be earlier,
 *  but the clocks of two processes needn't agree to the millisecond. */
function sessionSince(startedAt: number): number {
  return startedAt - 5_000;
}

/** Claude Code's own total for the conversation, from its main transcript. */
function conversationUsd(tracked: Tracked): number | undefined {
  let best: number | undefined;
  for (const reader of tracked.readers.values()) {
    if (!(reader.parser instanceof ClaudeTranscript) || reader.file.includes(`${path.sep}subagents${path.sep}`)) continue;
    const total = reader.parser.conversationTotal();
    if (total !== undefined) best = Math.max(best ?? 0, total);
  }
  return best;
}

// --- Finding the logs ---------------------------------------------------------------

type Tree = Map<number, { pid: number; command: string }[]>;

/** Every process's children, from one `ps` — cheaper than asking per pid. */
function processTree(): Promise<Tree> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const tree: Tree = new Map();
      if (err) return resolve(tree);
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const [pid, ppid, command] = [Number(match[1]), Number(match[2]), match[3].trim()];
        const siblings = tree.get(ppid) ?? [];
        siblings.push({ pid, command });
        tree.set(ppid, siblings);
      }
      resolve(tree);
    });
  });
}

function descendants(tree: Tree, root: number): { pid: number; command: string }[] {
  const found: { pid: number; command: string }[] = [];
  const queue = [root];
  while (queue.length > 0 && found.length < 500) {
    for (const child of tree.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** `~/.claude` and every `~/.claude-*` that Claude Code has run from. */
export async function claudeConfigDirs(): Promise<string[]> {
  const home = homedir();
  const names = await readdir(home).catch(() => [] as string[]);
  const dirs = names.filter((name) => name === '.claude' || name.startsWith('.claude-')).map((name) => path.join(home, name));
  const withSessions = await Promise.all(
    dirs.map(async (dir) => ((await stat(path.join(dir, 'sessions')).then((s) => s.isDirectory()).catch(() => false)) ? dir : undefined))
  );
  return withSessions.filter((dir): dir is string => dir !== undefined);
}

/** Claude Code's project folder name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export async function claudeTranscript(config: string, pid: number): Promise<string | undefined> {
  let meta: { sessionId?: string; cwd?: string };
  try {
    meta = JSON.parse(await readFile(path.join(config, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  if (!meta.sessionId || !/^[\w-]+$/.test(meta.sessionId)) return undefined;
  const projects = path.join(config, 'projects');
  if (meta.cwd) {
    const direct = path.join(projects, claudeProjectSlug(meta.cwd), `${meta.sessionId}.jsonl`);
    if (await stat(direct).then(() => true).catch(() => false)) return direct;
  }
  // The folder-name rule is Claude Code's, not ours; look it up if it moved.
  for (const folder of await readdir(projects).catch(() => [] as string[])) {
    const candidate = path.join(projects, folder, `${meta.sessionId}.jsonl`);
    if (await stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

/** The Codex log for a session in `cwd` that started after `since`, not already someone's. */
export async function findCodexLog(cwd: string, since: number, claimed: Set<string>): Promise<string | undefined> {
  const root = path.join(homedir(), '.codex', 'sessions');
  const days = new Set<string>();
  for (let t = since - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    days.add(path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  const candidates: { file: string; startedAt: number }[] = [];
  for (const day of days) {
    for (const name of await readdir(day).catch(() => [] as string[])) {
      const file = path.join(day, name);
      if (!name.endsWith('.jsonl') || claimed.has(file)) continue;
      const meta = codexSessionMeta(await firstLine(file));
      if (meta && meta.cwd === cwd && meta.startedAt >= since - 5_000) candidates.push({ file, startedAt: meta.startedAt });
    }
  }
  return candidates.sort((a, b) => a.startedAt - b.startedAt)[0]?.file;
}

/** A log's first line, without reading the rest of the file. */
async function firstLine(file: string): Promise<string> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    return end >= 0 ? text.slice(0, end) : text;
  } finally {
    await handle.close();
  }
}

// --- Quick jobs -----------------------------------------------------------------------

function quickRecord(job: QuickJob): UsageRecord {
  const models: ModelUsage[] = job.tokens
    ? [{ model: job.model, input: job.tokens.input, output: job.tokens.output, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }]
    : [];
  return {
    id: job.id,
    title: `${QUICK_KIND_LABEL[job.kind]} · ${job.subject}`,
    subject: job.subject,
    kind: job.kind,
    runnerName: 'Quick model',
    source: 'quick',
    startedAt: job.startedAt,
    updatedAt: job.finishedAt ?? job.startedAt,
    models
  };
}
