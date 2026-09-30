/**
 * What an agent Baton started says it is doing (item 112): Working, Input
 * (a question or a permission prompt waiting on you) or Done (its turn is
 * over) — from the agent itself, never guessed from terminal output.
 *
 *   Claude Code  hooks, added through the same `--settings` as the status-line
 *                recorder (item 108): prompt submitted and tool use → Working,
 *                a permission prompt → Input, Stop → Done. Your own hooks
 *                keep running beside them.
 *   Codex        its `notify` command fires when a turn completes → Done. Your
 *                own `notify` (config.toml) still runs, after Baton's. Codex
 *                has nothing for its approval prompts, so Sessions uses the
 *                bell there → Input.
 *   OpenCode     a small plugin, handed only to the sessions Baton starts
 *                through OPENCODE_CONFIG_CONTENT, beside your own plugins.
 *
 * Each one writes a single word to `status/<session id>` in Baton's data
 * folder, named by the BATON_SESSION_ID every session is started with; the
 * watcher here reads it. Outside Baton the scripts do nothing.
 */

import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { modelFamily } from '@baton/core';
import type { Runner } from '@baton/agent';

export type AgentState = 'working' | 'input' | 'done';
export type StatusSource = 'claude' | 'codex' | 'opencode';

const STATES = new Set<AgentState>(['working', 'input', 'done']);

const HOOK = `#!/bin/sh
# Baton's agent-status hook (item 112). Writes one word for the session Baton
# started this agent in; does nothing anywhere else.
#   $1  working | input | done     $2  claude | codex
#   codex: $3 your own notify command, base64 (may be empty), $4 Codex's JSON
state=$1
case "$2" in
  claude)
    payload=$(cat)
    if [ "$state" = input ]; then
      # "Waiting for your input" after a finished turn is still Done; only a
      # permission prompt or a question is Input.
      case "$payload" in *idle_prompt*|*'waiting for your input'*) exit 0 ;; esac
    fi ;;
  codex)
    if [ -n "$3" ]; then
      next=$(printf '%s' "$3" | /usr/bin/base64 -D 2>/dev/null)
      [ -n "$next" ] && /bin/sh -c "$next \\"\\$1\\"" sh "$4" >/dev/null 2>&1 &
    fi ;;
esac
[ -n "$BATON_STATUS_DIR" ] && [ -n "$BATON_SESSION_ID" ] || exit 0
file="$BATON_STATUS_DIR/$BATON_SESSION_ID"
printf '%s' "$state" > "$file.$$" 2>/dev/null && mv -f "$file.$$" "$file"
exit 0
`;

const PLUGIN = `// Baton's OpenCode plugin (item 112): says Working, Input or Done for the
// session Baton started OpenCode in. Loaded only there, through
// OPENCODE_CONFIG_CONTENT; it does nothing without BATON_SESSION_ID.
import { renameSync, writeFileSync } from "node:fs";

const children = new Set();
let last;

function set(state) {
  const dir = process.env.BATON_STATUS_DIR;
  const id = process.env.BATON_SESSION_ID;
  if (!dir || !id || state === last) return;
  last = state;
  try {
    const file = dir + "/" + id;
    writeFileSync(file + "." + process.pid, state);
    renameSync(file + "." + process.pid, file);
  } catch {}
}

export const BatonStatus = async () => ({
  event: async ({ event }) => {
    const type = event && event.type;
    const p = (event && event.properties) || {};
    if (!type) return;
    // A subagent's own sessions finishing is not the agent finishing.
    if (type === "session.created" && p.info && p.info.parentID) { children.add(p.info.id); return; }
    const child = children.has(p.sessionID);
    if (/^(permission|question)(\\.v2)?\\.asked$/.test(type)) return set("input");
    if (/^(permission|question)(\\.v2)?\\.(replied|rejected)$/.test(type)) return set("working");
    if (child) return;
    if (type === "session.status") {
      const status = p.status && p.status.type;
      if (status === "busy" || status === "retry") set("working");
      else if (status === "idle") set("done");
    } else if (type === "session.idle") {
      set("done");
    }
  }
});

export default { id: "baton-status", server: BatonStatus };
`;

export interface RunnerStatus {
  source?: StatusSource;
  /** Merged into the `--settings` Claude is started with. */
  claudeSettings?: Record<string, unknown>;
  args: string[];
  env: Record<string, string>;
}

export class AgentStatus {
  private watcher?: FSWatcher;

  constructor(private readonly userData: string) {}

  get dir(): string {
    return path.join(this.userData, 'status');
  }

  private get hook(): string {
    return path.join(this.userData, 'bin', 'baton-agent-status.sh');
  }

  private get plugin(): string {
    return path.join(this.userData, 'bin', 'baton-opencode-status.js');
  }

  /** What a runner is started with so it reports its status; nothing for an agent that can't. */
  async forRunner(runner: Runner): Promise<RunnerStatus> {
    const none: RunnerStatus = { args: [], env: {} };
    const family = modelFamily(runner.command);
    if (!family) return none;
    try {
      await mkdir(path.dirname(this.hook), { recursive: true });
      await mkdir(this.dir, { recursive: true });
      if (family === 'claude') {
        await this.writeHook();
        const run = (state: AgentState) => [{ type: 'command', command: `${shellQuote(this.hook)} ${state} claude` }];
        return {
          source: 'claude',
          args: [],
          env: {},
          claudeSettings: {
            hooks: {
              UserPromptSubmit: [{ hooks: run('working') }],
              PreToolUse: [{ matcher: '*', hooks: run('working') }],
              PostToolUse: [{ matcher: '*', hooks: run('working') }],
              Notification: [{ hooks: run('input') }],
              Stop: [{ hooks: run('done') }]
            }
          }
        };
      }
      if (family === 'codex') {
        await this.writeHook();
        const own = codexNotify();
        // A notify Baton can't read is left alone rather than replaced.
        if (own === 'unreadable') return { source: 'codex', args: [], env: {} };
        const next = own ? Buffer.from(own.map(shellQuote).join(' ')).toString('base64') : '';
        return { source: 'codex', args: ['-c', `notify=${JSON.stringify([this.hook, 'done', 'codex', next])}`], env: {} };
      }
      await writeFile(this.plugin, PLUGIN, 'utf8');
      return {
        source: 'opencode',
        args: [],
        env: { OPENCODE_CONFIG_CONTENT: withPlugin(process.env['OPENCODE_CONFIG_CONTENT'], `file://${this.plugin}`) }
      };
    } catch {
      return none;
    }
  }

  private async writeHook(): Promise<void> {
    await writeFile(this.hook, HOOK, 'utf8');
    await chmod(this.hook, 0o755);
  }

  /** Every state already written, then each one as it changes. */
  async watch(onState: (sessionId: string, state: AgentState) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const read = async (name: string) => {
      if (!/^[\w-]+$/.test(name)) return;
      const word = (await readFile(path.join(this.dir, name), 'utf8').catch(() => '')).trim();
      if (STATES.has(word as AgentState)) onState(name, word as AgentState);
    };
    for (const name of await readdir(this.dir).catch(() => [] as string[])) await read(name);
    this.watcher = watch(this.dir, (_event, name) => { if (name) void read(String(name)); });
  }

  /** A closed session's file goes with it. */
  forget(sessionId: string): void {
    if (/^[\w-]+$/.test(sessionId)) void rm(path.join(this.dir, sessionId), { force: true });
  }

  dispose(): void {
    this.watcher?.close();
  }
}

/** Your own Codex `notify` command, to run after Baton's, when it's a plain list of strings. */
function codexNotify(): string[] | undefined | 'unreadable' {
  const file = path.join(process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'), 'config.toml');
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8');
    if (!/^\s*notify\s*=/m.test(text)) return undefined;
    const match = /^\s*notify\s*=\s*(\[.*\])\s*$/m.exec(text);
    const list = match ? JSON.parse(match[1]!) as unknown : undefined;
    return Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === 'string') ? list as string[] : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Adds the plugin to whatever inline OpenCode config was already set. */
export function withPlugin(existing: string | undefined, plugin: string): string {
  let config: Record<string, unknown> = {};
  try { config = existing ? JSON.parse(existing) as Record<string, unknown> : {}; } catch { /* replaced */ }
  const plugins = Array.isArray(config['plugin']) ? config['plugin'] as unknown[] : [];
  return JSON.stringify({ ...config, plugin: [...plugins, plugin] });
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
