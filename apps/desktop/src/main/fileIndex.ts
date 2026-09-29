/**
 * ⌘P quick open (item 100): every file in the active workspace's folders.
 *
 * Built when ⌘P is pressed, never on launch or when the Workspace view opens
 * (nothing expensive runs on its own), then kept for a short while so typing
 * and reopening are instant. Inside a git repository the list is git's own —
 * `git ls-files` for tracked and untracked-but-not-ignored files — so
 * `node_modules`, build output and anything in `.gitignore` stay out, exactly
 * as in VS Code. Outside one, a walk that skips the usual heavy folders, with
 * a ceiling so a stray home directory can't stall it.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface IndexedFile {
  /** Absolute. */
  path: string;
  /** Relative to its workspace folder, with the folder's name in front when
   *  the workspace has more than one — what the picker shows and matches. */
  rel: string;
}

const SKIP = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.cache', 'Pods', 'DerivedData', '.turbo', '.idea', '.gradle'
]);
const MAX_FILES = 60_000;
const FRESH_MS = 60_000;

function gitFiles(repo: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => {
        if (error) resolve(undefined);
        else resolve(stdout.split('\0').filter(Boolean));
      });
  });
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // A repository inside a plain folder is listed by git, not walked.
  if (dir !== root && entries.some((e) => e.name === '.git')) {
    const files = await gitFiles(dir);
    if (files) {
      for (const f of files) out.push(path.relative(root, path.join(dir, f)));
      return;
    }
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (SKIP.has(entry.name) || entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
}

async function listFolder(folder: string): Promise<string[]> {
  const isRepo = await stat(path.join(folder, '.git')).then(() => true, () => false);
  if (isRepo) {
    const files = await gitFiles(folder);
    if (files) return files.slice(0, MAX_FILES);
  }
  const out: string[] = [];
  await walk(folder, folder, out);
  return out;
}

export class FileIndex {
  private cache?: { key: string; at: number; files: Promise<IndexedFile[]> };

  /** The files in `folders`; from the cache when it's recent, unless `force`. */
  files(folders: string[], force = false): Promise<IndexedFile[]> {
    const key = folders.join('\n');
    if (!force && this.cache && this.cache.key === key && Date.now() - this.cache.at < FRESH_MS) {
      return this.cache.files;
    }
    const files = (async () => {
      const lists = await Promise.all(folders.map(async (folder) => ({ folder, files: await listFolder(folder) })));
      const prefix = folders.length > 1;
      return lists.flatMap(({ folder, files: rel }) =>
        rel.map((r) => ({ path: path.join(folder, r), rel: prefix ? path.join(path.basename(folder), r) : r })));
    })();
    this.cache = { key, at: Date.now(), files };
    // A failed listing must not be served from the cache for a minute.
    files.catch(() => { if (this.cache?.files === files) this.cache = undefined; });
    return files;
  }
}
