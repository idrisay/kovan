/**
 * Finding the clones on this machine, ported from `DevHubKit/RepoIndex.swift`.
 *
 * An agent has to be started *somewhere*. The watched folders say where to
 * look; this says which of them are git repositories and what GitHub calls
 * them, so a run on `acme/web` starts in the clone of `acme/web` rather than
 * asking the user to pick a directory every time.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Clone {
  /** Absolute path of the working tree. */
  path: string;
  /** `owner/name` from the origin remote, when it is a GitHub remote. */
  slug?: string;
  branch?: string;
}

/** `owner/name` out of any of the shapes a GitHub remote takes. */
export function slugFromRemote(url: string): string | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');
  // git@host:owner/name — scp-like syntax, which is not a URL and will not parse
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(cleaned);
  const pathPart = scp
    ? scp[1]
    : /^[a-z]+:\/\//i.test(cleaned)
      ? new URL(cleaned).pathname.replace(/^\//, '')
      : undefined;
  if (!pathPart) return undefined;
  const parts = pathPart.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : undefined;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function describe(dir: string): Promise<Clone | undefined> {
  if (!(await isDirectory(path.join(dir, '.git')))) {
    return undefined;
  }
  const [remote, branch] = await Promise.all([
    run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5000 })
      .then((r) => r.stdout.trim())
      .catch(() => ''),
    run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
      .then((r) => r.stdout.trim())
      .catch(() => undefined)
  ]);
  return { path: dir, slug: remote ? slugFromRemote(remote) : undefined, branch };
}

/**
 * Every clone under the watched folders.
 *
 * A watched folder is very often a clone itself, so it is tested before its
 * children are walked. Depth is capped at one level below each folder: people
 * keep `~/code/acme/web`, not `~/code/a/b/c/d/web`, and an uncapped walk on a
 * home directory takes minutes.
 */
export async function findClones(folders: readonly string[]): Promise<Clone[]> {
  const found = new Map<string, Clone>();

  await Promise.all(
    folders.map(async (folder) => {
      const self = await describe(folder);
      if (self) {
        found.set(self.path, self);
        // A clone's subdirectories are its source, not more clones.
        return;
      }
      let entries: string[];
      try {
        entries = await readdir(folder);
      } catch {
        return;
      }
      await Promise.all(
        entries
          .filter((name) => !name.startsWith('.'))
          .map(async (name) => {
            const child = await describe(path.join(folder, name));
            if (child) {
              found.set(child.path, child);
            }
          })
      );
    })
  );

  return [...found.values()].sort((a, b) => (a.slug ?? a.path).localeCompare(b.slug ?? b.path));
}

/**
 * The folder that contains every one of these paths.
 *
 * A workspace is often several clones side by side — `acme-backend` and
 * `acme-frontend`, each its own watched folder — and a ticket rarely says in
 * advance which one it needs, or says both. Starting an agent in any single one
 * puts the others out of reach; their common parent leaves everything reachable
 * with a `cd`.
 */
export function commonAncestor(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const split = paths.map((p) => p.split('/').filter(Boolean));
  let shared = split[0]!;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.length > 0 ? `/${shared.join('/')}` : undefined;
}

export interface RunTarget {
  path: string;
  /** A clone's `owner/name`, or a folder's own name. */
  label: string;
}

/**
 * The folders to offer, each exactly once.
 *
 * A watched folder that is itself a clone appears in both lists. The clone
 * wins, because a slug says which repository this is and a directory name only
 * says what somebody happened to call the folder.
 */
export function runTargets(clones: readonly Clone[], folders: readonly string[]): RunTarget[] {
  const seen = new Set<string>();
  const targets: RunTarget[] = [];

  for (const clone of clones) {
    if (!seen.has(clone.path)) {
      seen.add(clone.path);
      targets.push({ path: clone.path, label: clone.slug ?? path.basename(clone.path) });
    }
  }
  for (const folder of folders) {
    if (!seen.has(folder)) {
      seen.add(folder);
      targets.push({ path: folder, label: path.basename(folder) });
    }
  }
  return targets;
}

export {
  parseStatus,
  readStatus,
  changeCount,
  EMPTY_STATUS,
  type ChangeKind,
  type ChangeSide,
  type FileChange,
  type RepoStatus
} from './status';

export {
  parseDiff,
  readDiff,
  EMPTY_DIFF,
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  type DiffSide,
  type FileDiff
} from './diff';

export { revertTracked, type RevertSide } from './revert';
