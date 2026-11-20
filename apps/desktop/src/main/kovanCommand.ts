/**
 * The `kovan` shell command (item 178): installing and removing the script,
 * and reading what a path on the command line points at.
 *
 * Where it goes, in order: the first of `/usr/local/bin`, `~/.local/bin` and
 * `~/bin` that is on your login shell's PATH and that Kovan may write to;
 * else `~/.local/bin`, with a line saying how to put it on PATH. No admin
 * password is ever asked for. A `kovan` that Kovan didn't write is never
 * replaced or removed.
 */

import { app } from 'electron';
import { access, chmod, mkdir, readFile, rm, stat, writeFile, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  appBundleOf, isKovanCommandScript, kovanCommandScript, openCandidates, scriptTarget, type OpenCandidate
} from '@kovan/core';
import { shellEnvironment } from '@kovan/agent';

export interface KovanCommandStatus {
  /** Where our script is, when it is installed. */
  installed?: string;
  /** False when it's installed in a folder your shell's PATH doesn't have. */
  onPath?: boolean;
  /** It launches another copy of Kovan (moved, or an older build): Install again fixes it. */
  stale?: boolean;
  /** Another program called `kovan` that we won't touch. */
  conflict?: string;
  /** Why it can't be installed from this copy, e.g. a development build. */
  unavailable?: string;
}

const NAME = 'kovan';

function candidates(): string[] {
  return ['/usr/local/bin', path.join(homedir(), '.local', 'bin'), path.join(homedir(), 'bin')];
}

/** What the script launches: the .app on macOS, the AppImage or the binary on Linux. */
function appTarget(): string | undefined {
  if (process.platform === 'darwin') return appBundleOf(process.execPath);
  return process.env['APPIMAGE'] || process.execPath;
}

async function pathDirs(): Promise<string[]> {
  const env = await shellEnvironment.environment().catch(() => ({} as Record<string, string>));
  return (env['PATH'] ?? process.env['PATH'] ?? '').split(':').filter(Boolean).map((d) => path.resolve(d));
}

async function ours(file: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  return text !== undefined && isKovanCommandScript(text) ? text : undefined;
}

async function writable(dir: string): Promise<boolean> {
  return access(dir, constants.W_OK).then(() => true, () => false);
}

export async function kovanCommandStatus(): Promise<KovanCommandStatus> {
  const target = appTarget();
  const unavailable = !app.isPackaged
    ? 'This is a development build. Install the command from the installed Kovan app.'
    : !target ? 'Kovan could not find its own app bundle.' : undefined;
  const onPath = await pathDirs();
  for (const dir of candidates()) {
    const file = path.join(dir, NAME);
    const text = await ours(file);
    if (text) {
      return {
        installed: file,
        onPath: onPath.includes(dir),
        stale: Boolean(target) && scriptTarget(text) !== target,
        ...(unavailable ? { unavailable } : {})
      };
    }
  }
  const found = await shellEnvironment.which(NAME).catch(() => undefined);
  if (found && !(await ours(found))) return { conflict: found, ...(unavailable ? { unavailable } : {}) };
  return unavailable ? { unavailable } : {};
}

export async function installKovanCommand(): Promise<KovanCommandStatus & { message: string }> {
  const before = await kovanCommandStatus();
  if (before.unavailable) return { ...before, message: before.unavailable };
  if (before.conflict) return { ...before, message: `Another program called kovan is at ${before.conflict}, so Kovan left it alone.` };
  const target = appTarget()!;
  const script = kovanCommandScript({ platform: process.platform === 'darwin' ? 'darwin' : 'linux', app: target });
  const onPath = await pathDirs();
  // Replace ours where it is; otherwise the first folder on PATH we may write to.
  let dir = before.installed ? path.dirname(before.installed) : undefined;
  if (!dir) {
    for (const candidate of candidates()) {
      if (onPath.includes(candidate) && (await writable(candidate))) { dir = candidate; break; }
    }
  }
  dir ??= path.join(homedir(), '.local', 'bin');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, NAME);
  const existing = await stat(file).catch(() => undefined);
  if (existing && !(await ours(file))) {
    return { conflict: file, message: `Another program called kovan is at ${file}, so Kovan left it alone.` };
  }
  await writeFile(file, script, { encoding: 'utf8', mode: 0o755 });
  await chmod(file, 0o755);
  const status = await kovanCommandStatus();
  return {
    ...status,
    message: status.onPath === false
      ? `Installed at ${file}, but that folder isn't on your PATH. Add export PATH="${dir}:$PATH" to your shell's profile.`
      : `Installed at ${file}. Open a new terminal and try kovan .`
  };
}

export async function removeKovanCommand(): Promise<KovanCommandStatus & { message: string }> {
  const before = await kovanCommandStatus();
  if (!before.installed) return { ...before, message: 'The kovan command is not installed.' };
  await rm(before.installed, { force: true });
  return { ...(await kovanCommandStatus()), message: `Removed ${before.installed}.` };
}

export interface OpenTarget {
  path: string;
  directory: boolean;
  line?: number;
  column?: number;
}

/**
 * A path from the command line, read against the terminal's folder: the
 * first reading of it (see `openCandidates`) that exists. `~` is expanded in
 * case the shell didn't (a quoted `"~/x"`).
 */
export async function resolveOpenTarget(raw: string, cwd: string): Promise<OpenTarget | undefined> {
  const tries: OpenCandidate[] = openCandidates(raw);
  for (const c of tries) {
    const expanded = c.path === '~' ? homedir() : c.path.startsWith('~/') ? path.join(homedir(), c.path.slice(2)) : c.path;
    const absolute = path.resolve(cwd || homedir(), expanded);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;
    // A line only means something in a file.
    if (info.isDirectory()) return { path: absolute, directory: true };
    return { path: absolute, directory: false, ...(c.line ? { line: c.line } : {}), ...(c.column ? { column: c.column } : {}) };
  }
  return undefined;
}
