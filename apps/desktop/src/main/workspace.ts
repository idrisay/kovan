/**
 * Workspaces: named sets of folders, the repositories inside them, and the
 * files those repositories contain.
 *
 * SECURITY, and it is the whole reason this file is shaped the way it is.
 * Every path in here arrives from the renderer, which displays other people's
 * pull request bodies and ticket descriptions. If an IPC channel took a path
 * and read it, the worst case is not a bug — it is `~/.ssh/id_rsa` leaving the
 * machine. So *no* channel reads a path it was given. Each one resolves the
 * path first (`inside`), which:
 *
 *   1. realpaths it, so a symlink planted inside a workspace cannot point out
 *      of one — checking the string before resolution would pass `ws/link`
 *      while the read followed it to `/etc`;
 *   2. realpaths the roots too, since `/tmp` is itself a symlink on macOS and
 *      the two sides would otherwise never compare equal;
 *   3. requires a path separator after the root, so `/Users/me/work-secrets`
 *      is not accepted as living under `/Users/me/work`.
 *
 * A path that fails any of those is refused, not clamped. There is no reading
 * outside a folder the user explicitly picked.
 */

import { dialog, type BrowserWindow } from 'electron';
import { readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EMPTY_STATUS,
  changeCount,
  findClones,
  readDiff,
  readStatus,
  type Clone,
  type DiffSide,
  type FileDiff,
  type RepoStatus
} from '@baton/git';
import type { DesktopHost } from './host';

export interface Workspace {
  id: string;
  name: string;
  folders: string[];
}

export interface WorkspaceRepo extends Clone {
  name: string;
  /** Undefined until the status has been read; zero is a real answer. */
  changes?: number;
}

export interface Entry {
  name: string;
  path: string;
  directory: boolean;
  /** A directory that is itself a clone, so the tree can mark it. */
  repo?: boolean;
}

/**
 * What the file looked like when it was read.
 *
 * `mtimeMs` and `bytes` together are the save guard: an agent working in the
 * same clone is the expected case here, not an exotic one, so a save carries
 * these back and is refused if either has moved. Comparing content hashes
 * would be stricter, but it means re-reading the whole file on every save of
 * every tab; two cheap stat fields catch the case that matters.
 */
export interface FileStamp {
  mtimeMs: number;
  bytes: number;
}

export type FileBody =
  | ({ kind: 'text'; text: string; lines: number; truncated: boolean } & FileStamp)
  | ({ kind: 'binary' } & FileStamp)
  | ({ kind: 'too-large' } & FileStamp);

export type WriteResult =
  | { ok: true; stamp: FileStamp }
  | { ok: false; reason: 'stale'; stamp: FileStamp }
  | { ok: false; reason: 'error'; message: string };

/**
 * 2 MB, and the cap is not arbitrary.
 *
 * The whole file crosses IPC as a string and is then handed to a syntax
 * highlighter that walks it character by character. A 50 MB log would freeze
 * the renderer for seconds with no way to cancel — and nobody reads a 50 MB
 * file in a side pane anyway. Past this, the view says so instead of trying.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Enough to catch a NUL in any real binary's header. */
const SNIFF_BYTES = 8192;

export class Workspaces {
  private repoCache = new Map<string, WorkspaceRepo[]>();

  constructor(private readonly host: DesktopHost) {}

  // --- The workspaces themselves --------------------------------------------

  list(): Workspace[] {
    return this.host.config.get<Workspace[]>('workspaces', []);
  }

  activeId(): string | undefined {
    const all = this.list();
    const saved = this.host.config.get<string | undefined>('workspace.active', undefined);
    // A saved id can outlive the workspace it named — falling back to the
    // first one keeps the view populated instead of blank-but-not-empty.
    return all.some((w) => w.id === saved) ? saved : all[0]?.id;
  }

  async activate(id: string): Promise<void> {
    await this.host.config.set('workspace.active', id);
  }

  private async save(all: Workspace[]): Promise<void> {
    await this.host.config.set('workspaces', all);
  }

  /**
   * Picks a folder and makes a workspace of it.
   *
   * The folder's own basename is the default name because it is almost always
   * right, and a dialog that asks twice for something it could infer is a
   * dialog people learn to dismiss.
   */
  async create(window?: BrowserWindow): Promise<Workspace | undefined> {
    const folder = await this.pickFolder(window, 'Choose a folder for this workspace');
    if (!folder) return undefined;

    const workspace: Workspace = {
      id: randomUUID(),
      name: path.basename(folder),
      folders: [folder]
    };
    await this.save([...this.list(), workspace]);
    await this.activate(workspace.id);
    return workspace;
  }

  async addFolder(id: string, window?: BrowserWindow): Promise<Workspace | undefined> {
    const folder = await this.pickFolder(window, 'Add a folder to this workspace');
    if (!folder) return undefined;

    const all = this.list();
    const workspace = all.find((w) => w.id === id);
    if (!workspace) return undefined;
    if (!workspace.folders.includes(folder)) {
      workspace.folders = [...workspace.folders, folder];
      this.repoCache.delete(id);
      await this.save(all);
    }
    return workspace;
  }

  async removeFolder(id: string, folder: string): Promise<Workspace | undefined> {
    const all = this.list();
    const workspace = all.find((w) => w.id === id);
    if (!workspace) return undefined;
    workspace.folders = workspace.folders.filter((f) => f !== folder);
    this.repoCache.delete(id);
    await this.save(all);
    return workspace;
  }

  /**
   * Forgets a workspace. It does not touch a single file on disk — "remove"
   * here means "stop listing these folders", and the naming has to make that
   * unmistakable, because the opposite reading is unrecoverable.
   */
  async forget(id: string): Promise<void> {
    this.repoCache.delete(id);
    await this.save(this.list().filter((w) => w.id !== id));
    if (this.host.config.get<string | undefined>('workspace.active', undefined) === id) {
      await this.host.config.set('workspace.active', this.list()[0]?.id);
    }
  }

  private async pickFolder(
    window: BrowserWindow | undefined,
    title: string
  ): Promise<string | undefined> {
    const options = {
      title,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  }

  // --- Repositories ----------------------------------------------------------

  /**
   * The clones inside a workspace's folders.
   *
   * Cached because `findClones` shells out to git twice per candidate
   * directory, and the explorer asks for this on every mount. `force` is what
   * the refresh button passes.
   */
  async repos(id: string, force = false): Promise<WorkspaceRepo[]> {
    if (!force) {
      const cached = this.repoCache.get(id);
      if (cached) return cached;
    }
    const workspace = this.list().find((w) => w.id === id);
    if (!workspace) return [];

    const clones = await findClones(workspace.folders);
    const repos = clones.map((clone) => ({
      ...clone,
      name: clone.slug ?? path.basename(clone.path)
    }));
    this.repoCache.set(id, repos);
    return repos;
  }

  /** Status for one clone, with the count the badge shows. */
  async status(repo: string): Promise<RepoStatus & { changes: number }> {
    const resolved = await this.inside(repo);
    try {
      const status = await readStatus(resolved);
      return { ...status, changes: changeCount(status) };
    } catch (error) {
      // A folder that stopped being a repository, or a git that is not
      // installed. An empty status renders as "no changes", which is a far
      // better failure than an explorer that will not open.
      this.host.log.warn(`status failed for ${repo}`, error);
      return { ...EMPTY_STATUS, changes: 0 };
    }
  }

  async diff(repo: string, file: string, side: DiffSide, from?: string): Promise<FileDiff> {
    const resolved = await this.inside(repo);
    // `file` is repo-relative and goes to git as a pathspec after `--`, never
    // to the filesystem. Reject an absolute or climbing path anyway: a
    // pathspec of `../../etc/passwd` would make git itself do the escaping.
    if (path.isAbsolute(file) || file.split('/').includes('..')) {
      throw new Error('Invalid path');
    }
    return readDiff(resolved, file, side, from);
  }

  // --- Files -----------------------------------------------------------------

  /**
   * One directory's children, sorted the way an explorer reads: folders first,
   * then files, each case-insensitively by name.
   *
   * Lazy by design — only the expanded directory is listed. A recursive walk
   * of a folder holding `node_modules` is tens of thousands of stats, which is
   * exactly the "expensive work on open" this app avoids everywhere else.
   */
  async tree(dir: string): Promise<Entry[]> {
    const resolved = await this.inside(dir);
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries: Entry[] = [];

    for (const dirent of dirents) {
      // `.git` is machinery, not source. Everything else stays visible: this
      // is a file explorer, and hiding files by guesswork is how people end up
      // believing a file is missing.
      if (dirent.name === '.git') continue;

      const full = path.join(resolved, dirent.name);
      let directory = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        // A symlink's own type says nothing about its target, and a broken
        // link must not abort the whole listing.
        directory = await stat(full)
          .then((s) => s.isDirectory())
          .catch(() => false);
      }
      entries.push({ name: dirent.name, path: full, directory });
    }

    entries.sort((a, b) =>
      a.directory !== b.directory
        ? a.directory
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    return entries;
  }

  async read(file: string): Promise<FileBody> {
    const resolved = await this.inside(file);
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error('Not a file');
    }
    const stamp: FileStamp = { mtimeMs: info.mtimeMs, bytes: info.size };

    if (info.size > MAX_FILE_BYTES) {
      return { kind: 'too-large', ...stamp };
    }

    const bytes = await readFile(resolved);
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
      return { kind: 'binary', ...stamp };
    }

    const text = bytes.toString('utf8');
    return {
      kind: 'text',
      text,
      lines: text.length === 0 ? 0 : text.split('\n').length,
      truncated: false,
      ...stamp
    };
  }

  /**
   * Saves an edited file.
   *
   * Three things have to hold, and each has bitten somebody:
   *
   * 1. **The path is inside a workspace folder.** `inside()` refuses anything
   *    else — the same boundary reads use. A write is the direction where
   *    getting this wrong is unrecoverable.
   * 2. **Nobody else changed it.** `expected` is the stamp from the read that
   *    filled the editor. An agent running in this clone edits the same files;
   *    silently overwriting its work is the outcome worth engineering against,
   *    so a moved mtime or size returns `stale` and the view offers a choice.
   *    Passing no `expected` is the explicit "overwrite anyway".
   * 3. **A crash cannot truncate the file.** The bytes go to a temp file in the
   *    *same directory* — same filesystem, so the rename is atomic — and that
   *    is renamed over the target. Writing in place means a crash between
   *    truncate and write leaves an empty file where the source used to be.
   */
  async write(file: string, text: string, expected?: FileStamp): Promise<WriteResult> {
    let resolved: string;
    try {
      resolved = await this.inside(file);
    } catch (error) {
      return { ok: false, reason: 'error', message: (error as Error).message };
    }

    try {
      const before = await stat(resolved);
      if (!before.isFile()) {
        return { ok: false, reason: 'error', message: 'Not a file' };
      }
      if (
        expected &&
        (before.mtimeMs !== expected.mtimeMs || before.size !== expected.bytes)
      ) {
        return {
          ok: false,
          reason: 'stale',
          stamp: { mtimeMs: before.mtimeMs, bytes: before.size }
        };
      }

      // Same directory, so rename() stays on one filesystem and is atomic.
      // A temp file in /tmp would make this a copy, which is not.
      const temporary = path.join(
        path.dirname(resolved),
        `.baton-${path.basename(resolved)}.${randomUUID().slice(0, 8)}`
      );
      try {
        // Carry the original's permission bits: writing 0644 over an
        // executable script silently un-executes it.
        await writeFile(temporary, text, { encoding: 'utf8', mode: before.mode & 0o777 });
        await rename(temporary, resolved);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }

      const after = await stat(resolved);
      return { ok: true, stamp: { mtimeMs: after.mtimeMs, bytes: after.size } };
    } catch (error) {
      this.host.log.error(`write failed for ${file}`, error);
      return { ok: false, reason: 'error', message: (error as Error).message };
    }
  }

  // --- The boundary ----------------------------------------------------------

  /**
   * Resolves a renderer-supplied path, or refuses it.
   *
   * See the note at the top of this file. The roots are every folder of every
   * workspace — not only the active one, because a tab can outlive a switch
   * and closing the file the user is reading would be worse than allowing it.
   */
  private async inside(candidate: string): Promise<string> {
    const folders = this.list().flatMap((w) => w.folders);
    if (folders.length === 0) {
      throw new Error('No workspace folders');
    }

    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      throw new Error('No such path');
    }

    for (const folder of folders) {
      let root: string;
      try {
        root = await realpath(folder);
      } catch {
        continue;
      }
      if (target === root || target.startsWith(root + path.sep)) {
        return target;
      }
    }
    throw new Error('Path is outside every workspace folder');
  }
}
