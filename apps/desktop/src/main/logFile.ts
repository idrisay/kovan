/**
 * The log on disk, so a problem can be looked at after it happened (item 83).
 *
 * Before this, every log line went to stdout, which the installed app has
 * nowhere to send: a crash in the window left a black screen and no trace.
 * Now every line also lands in `~/Library/Logs/Kovan/kovan.log` — the folder
 * Console.app already lists under Log Reports — and so does anything that
 * crashes in main or in the window.
 *
 * Appending a line is the only work it does. When the file passes 1 MB it is
 * renamed to `kovan.1.log` (replacing the previous one), so the two files
 * together never hold more than about 2 MB.
 */

import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';

const MAX_BYTES = 1_000_000;

let file: string | undefined;
let written = 0;

/** Where the log is. Resolved lazily, because `app.getPath('logs')` needs the app name set first. */
export function logFilePath(): string {
  if (!file) {
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'kovan.log');
    try {
      written = statSync(file).size;
    } catch {
      written = 0;
    }
  }
  return file;
}

function format(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  return inspect(arg, { depth: 4, breakLength: Infinity });
}

/** One line (or one stack) appended to the log. Never throws: logging must not be what breaks. */
export function appendLog(level: string, message: string, args: readonly unknown[] = []): void {
  try {
    const target = logFilePath();
    const text = [message, ...args.map(format)].join(' ');
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    if (written + line.length > MAX_BYTES) {
      renameSync(target, path.join(path.dirname(target), 'kovan.1.log'));
      written = 0;
    }
    appendFileSync(target, line, { mode: 0o600 });
    written += Buffer.byteLength(line);
  } catch {
    // A full disk or a missing permission: stdout still has it.
  }
}

/**
 * What the window reports when something in it throws. Everything here came
 * from the renderer, so it is treated as untrusted text: plain strings only,
 * and capped, so a runaway error loop can't fill the disk.
 */
export interface RendererErrorReport {
  kind: string;
  message: string;
  stack?: string;
  componentStack?: string;
  where?: string;
}

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

export function logRendererError(report: unknown): void {
  const r = (report && typeof report === 'object' ? report : {}) as Record<string, unknown>;
  const parts = [
    `[renderer ${cap(r['kind'], 40) ?? 'error'}]`,
    cap(r['message'], 2_000) ?? '(no message)',
    r['where'] ? `\n  where: ${cap(r['where'], 300)}` : '',
    r['stack'] ? `\n${cap(r['stack'], 8_000)}` : '',
    r['componentStack'] ? `\n  component stack:${cap(r['componentStack'], 4_000)}` : ''
  ];
  appendLog('error', parts.join(' '));
}
