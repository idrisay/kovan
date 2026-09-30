/**
 * Agents' plan limits for the run sheet (item 108), read from what the agents
 * themselves already write on this Mac — Kovan sends no request for them.
 *
 *   Claude Code  its status line is handed `rate_limits` on every refresh.
 *                For the Claude sessions Kovan starts, Kovan's own status-line
 *                wrapper saves that payload and then runs your usual status
 *                line unchanged. ccstatusline's cache, when present, is a
 *                head start until the first such session has run.
 *   Codex        writes `rate_limits` into its session log every turn.
 *   OpenCode     has no plan windows; today's requests per provider, and the
 *                last "limit reached" a provider sent back, from its database.
 *
 * Read when the run sheet opens: a directory listing, the tail of one log
 * file, one small read-only SQLite query. Nothing runs on a timer.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeLimitsFromCcstatusline, claudeLimitsFromStatusPayload, codexLimitsFromLine, modelFamily, newestLimits,
  settleWindows, type AgentLimits
} from '@kovan/core';
import type { Runner } from '@kovan/agent';

export interface ProviderDay {
  /** Requests today, per provider ("opencode", "nvidia"…). */
  requests: { provider: string; count: number }[];
  /** The last time in 24 hours a provider said its limit was reached. */
  limited?: { provider: string; at: number; message: string };
}

export interface RunnerLimits {
  limits?: AgentLimits;
  day?: ProviderDay;
}

const HOME = os.homedir();

// --- Claude: the status-line recorder ---------------------------------------

const RECORDER = `#!/bin/sh
# Kovan's status line for the Claude Code sessions it starts (item 108).
# Saves what Claude Code hands the status line when it carries rate limits,
# then runs your own status line with the same input, so it looks unchanged.
#   $1  file to save to      $2  your status-line command, base64
umask 077
payload=$(cat)
case "$payload" in
  *'"rate_limits"'*) printf '%s' "$payload" > "$1.$$" && mv -f "$1.$$" "$1" ;;
esac
[ -n "$2" ] || exit 0
next=$(printf '%s' "$2" | /usr/bin/base64 -D 2>/dev/null)
[ -n "$next" ] || exit 0
printf '%s' "$payload" | /bin/sh -c "$next"
`;

export class AgentLimitsReader {
  constructor(private readonly userData: string) {}

  private get dir(): string {
    return path.join(this.userData, 'limits');
  }

  private recordFile(runnerId: string): string {
    return path.join(this.dir, `claude-${runnerId.replace(/[^\w.-]/g, '_')}.json`);
  }

  /**
   * What a Claude-family session's `--settings` gets: its status line pointed
   * at the recorder, keeping the rest of your status-line settings (padding,
   * refresh interval) as they are. Nothing for any other agent, or if the
   * recorder can't be written.
   */
  async claudeSettings(runner: Runner): Promise<Record<string, unknown> | undefined> {
    if (modelFamily(runner.command) !== 'claude') return undefined;
    try {
      await mkdir(path.join(this.userData, 'bin'), { recursive: true });
      await mkdir(this.dir, { recursive: true });
      const script = path.join(this.userData, 'bin', 'kovan-claude-statusline.sh');
      await writeFile(script, RECORDER, 'utf8');
      await chmod(script, 0o755);
      const own = this.ownStatusLine(runner.command);
      const next = typeof own?.['command'] === 'string' ? Buffer.from(own['command']).toString('base64') : '';
      const statusLine = {
        ...(own ?? { padding: 0 }),
        type: 'command',
        command: `${shellQuote(script)} ${shellQuote(this.recordFile(runner.id))} ${shellQuote(next)}`
      };
      return { statusLine };
    } catch {
      return undefined;
    }
  }

  /** Your status line as set for this Claude command's config folder:
   *  `claude` → ~/.claude, `claude-personal` → ~/.claude-personal. */
  private ownStatusLine(command: string): Record<string, unknown> | undefined {
    const name = path.basename(command);
    const dirs = [name.startsWith('claude-') ? path.join(HOME, `.${name}`) : undefined, path.join(HOME, '.claude')]
      .filter((d): d is string => Boolean(d) && existsSync(d!));
    for (const dir of dirs) {
      try {
        const settings = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { statusLine?: Record<string, unknown> };
        if (settings.statusLine && typeof settings.statusLine === 'object') return settings.statusLine;
      } catch { /* next */ }
    }
    return undefined;
  }

  // --- Reading -------------------------------------------------------------

  async read(runners: Runner[]): Promise<Record<string, RunnerLimits>> {
    const now = Date.now();
    const out: Record<string, RunnerLimits> = {};
    let codex: Promise<AgentLimits | undefined> | undefined;
    let ccstatus: Promise<AgentLimits | undefined> | undefined;
    let opencode: Promise<ProviderDay | undefined> | undefined;
    await Promise.all(runners.map(async (runner) => {
      const family = modelFamily(runner.command);
      if (family === 'claude') {
        ccstatus ??= readCcstatusline();
        const limits = newestLimits(await this.readRecorded(runner.id), await ccstatus);
        if (limits) out[runner.id] = { limits: settleWindows(limits, now) };
      } else if (family === 'codex') {
        codex ??= readCodex();
        const limits = await codex;
        if (limits) out[runner.id] = { limits: settleWindows(limits, now) };
      } else if (path.basename(runner.command) === 'opencode') {
        opencode ??= readOpencodeDay();
        const day = await opencode;
        if (day) out[runner.id] = { day };
      }
    }));
    return out;
  }

  private async readRecorded(runnerId: string): Promise<AgentLimits | undefined> {
    const file = this.recordFile(runnerId);
    try {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      return claudeLimitsFromStatusPayload(JSON.parse(text), info.mtimeMs);
    } catch {
      return undefined;
    }
  }
}

async function readCcstatusline(): Promise<AgentLimits | undefined> {
  const file = path.join(HOME, '.cache', 'ccstatusline', 'usage.json');
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return claudeLimitsFromCcstatusline(JSON.parse(text), info.mtimeMs);
  } catch {
    return undefined;
  }
}

/** The newest Codex session log's last `rate_limits`, reading only its tail. */
async function readCodex(): Promise<AgentLimits | undefined> {
  const root = path.join(process.env['CODEX_HOME'] ?? path.join(HOME, '.codex'), 'sessions');
  const newestDirs = async (dir: string, take: number) =>
    (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).sort().reverse().slice(0, take).map((n) => path.join(dir, n));
  // sessions/YYYY/MM/DD/rollout-….jsonl — the two newest days are plenty.
  const days: string[] = [];
  for (const year of await newestDirs(root, 2)) {
    for (const month of await newestDirs(year, 2)) {
      days.push(...(await newestDirs(month, 2)));
    }
  }
  const files: { file: string; mtime: number }[] = [];
  for (const day of days.sort().reverse().slice(0, 2)) {
    for (const name of await readdir(day).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(day, name);
      const info = await stat(file).catch(() => undefined);
      if (info) files.push({ file, mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  // A session that has only just started may not have finished a turn yet.
  for (const { file } of files.slice(0, 5)) {
    const tail = await readTail(file, 512 * 1024);
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const limits = codexLimitsFromLine(lines[i]!);
      if (limits) return limits;
    }
  }
  return undefined;
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Today's OpenCode requests per provider, and the last limit a provider hit. */
async function readOpencodeDay(): Promise<ProviderDay | undefined> {
  const db = path.join(process.env['XDG_DATA_HOME'] ?? path.join(HOME, '.local', 'share'), 'opencode', 'opencode.db');
  if (!existsSync(db)) return undefined;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const query = (sql: string) => new Promise<Record<string, unknown>[]>((resolve) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      try { resolve(stdout.trim() ? JSON.parse(stdout) as Record<string, unknown>[] : []); } catch { resolve([]); }
    });
  });
  const [counts, limited] = await Promise.all([
    query(`select json_extract(data,'$.providerID') as provider, count(*) as count from message
      where json_extract(data,'$.role')='assistant' and json_extract(data,'$.time.created') >= ${since}
      group by provider order by count desc`),
    query(`select json_extract(data,'$.providerID') as provider, json_extract(data,'$.time.created') as at,
      json_extract(data,'$.error.data.message') as message from message
      where json_extract(data,'$.error.data.statusCode') = 429 and json_extract(data,'$.time.created') >= ${dayAgo}
      order by at desc limit 1`)
  ]);
  const requests = counts
    .filter((r) => typeof r['provider'] === 'string')
    .map((r) => ({ provider: String(r['provider']), count: Number(r['count']) || 0 }));
  const last = limited[0];
  return {
    requests,
    ...(last && typeof last['provider'] === 'string'
      ? { limited: { provider: String(last['provider']), at: Number(last['at']) || 0, message: String(last['message'] ?? 'Limit reached').split('\n')[0]!.slice(0, 200) } }
      : {})
  };
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
