/**
 * What has changed in a clone, from `git status --porcelain=v2`.
 *
 * Porcelain v2 rather than v1 because v1 collapses information this view needs:
 * v2 carries the branch, the ahead/behind counts and the rename source as
 * first-class fields instead of leaving them to be scraped out of human text.
 * It is also explicitly documented as stable for machines, which v1's `-s`
 * output is not.
 *
 * `-z` is not a nicety either. Without it git *quotes* any path containing a
 * space, a quote or a non-ASCII byte, so `src/My File.ts` comes back wrapped in
 * quotes with C-style escapes that would have to be un-escaped exactly right.
 * With `-z`, records are NUL-terminated and paths are emitted raw.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where a change lives. A file can be in both at once. */
export type ChangeSide = 'staged' | 'unstaged' | 'untracked';

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'conflicted'
  | 'untracked';

export interface FileChange {
  /** Repo-relative, forward-slashed, exactly as git reports it. */
  path: string;
  /** For a rename or copy, where it came from. */
  from?: string;
  side: ChangeSide;
  kind: ChangeKind;
}

export interface RepoStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** True when HEAD has no commits yet, where `branch.oid` is the literal `(initial)`. */
  unborn: boolean;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
}

const KIND: Record<string, ChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted'
};

export const EMPTY_STATUS: RepoStatus = {
  ahead: 0,
  behind: 0,
  unborn: false,
  staged: [],
  unstaged: [],
  untracked: []
};

/**
 * Parses the raw NUL-separated porcelain v2 stream.
 *
 * Exported separately from the process call so it can be tested against
 * captured output — the awkward cases here (renames, conflicts, unborn HEAD)
 * are tedious to reproduce against a live repository on demand.
 */
export function parseStatus(raw: string): RepoStatus {
  // A trailing NUL would otherwise yield one empty record at the end.
  const records = raw.split('\0');
  const status: RepoStatus = {
    ahead: 0,
    behind: 0,
    unborn: false,
    staged: [],
    unstaged: [],
    untracked: []
  };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const type = record[0];

    if (type === '#') {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head' && value !== '(detached)') status.branch = value;
      if (key === 'branch.oid' && value === '(initial)') status.unborn = true;
      if (key === 'branch.upstream') status.upstream = value;
      if (key === 'branch.ab') {
        // `+3 -1`, and either side can legitimately be zero.
        const ab = /^\+(\d+) -(\d+)$/.exec(value);
        if (ab) {
          status.ahead = Number(ab[1]);
          status.behind = Number(ab[2]);
        }
      }
      continue;
    }

    if (type === '?') {
      status.untracked.push({
        path: record.slice(2),
        side: 'untracked',
        kind: 'untracked'
      });
      continue;
    }

    // Ignored entries are only emitted with --ignored, which we never pass.
    if (type === '!') continue;

    if (type === 'u') {
      // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      // A conflict is neither staged nor unstaged — it is a thing to resolve —
      // but it has to appear somewhere, and the unstaged list is where the
      // work is.
      const path = fieldsAfter(record, 10);
      if (path) status.unstaged.push({ path, side: 'unstaged', kind: 'conflicted' });
      continue;
    }

    if (type !== '1' && type !== '2') continue;

    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` then, as the
    // NEXT NUL-separated record, the original path.
    const parts = record.split(' ');
    const xy = parts[1] ?? '..';
    const path = fieldsAfter(record, type === '1' ? 8 : 9);
    if (!path) continue;

    let from: string | undefined;
    if (type === '2') {
      // The rename source is its own record, so step over it — leaving it to
      // the loop would parse a bare path as an unknown record type.
      from = records[++i] || undefined;
    }

    const indexChar = xy[0] ?? '.';
    const treeChar = xy[1] ?? '.';

    if (indexChar !== '.') {
      status.staged.push({
        path,
        ...(from ? { from } : {}),
        side: 'staged',
        kind: KIND[indexChar] ?? 'modified'
      });
    }
    if (treeChar !== '.') {
      status.unstaged.push({
        path,
        side: 'unstaged',
        kind: KIND[treeChar] ?? 'modified'
      });
    }
  }

  return status;
}

/**
 * The n-th space-separated field onwards, kept whole.
 *
 * A path may contain spaces, so it cannot be taken as `parts[n]` — everything
 * from that field to the end of the record is the path.
 */
function fieldsAfter(record: string, n: number): string | undefined {
  let index = 0;
  for (let seen = 0; seen < n; seen++) {
    const next = record.indexOf(' ', index);
    if (next === -1) return undefined;
    index = next + 1;
  }
  return record.slice(index) || undefined;
}

export async function readStatus(repo: string): Promise<RepoStatus> {
  const { stdout } = await run(
    'git',
    ['-C', repo, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    // `all`, not `normal`. Under `normal` git collapses a wholly untracked
    // directory into a single entry ending in "/" — which has no filename to
    // show, and which `git diff` refuses outright because it is a directory,
    // so the row could be listed but never opened. `all` lists the files
    // inside it, every one of which is a thing you can actually look at.
    //
    // The cost is a longer list in a repository with no .gitignore. The buffer
    // cap below is what keeps that bounded: thousands of untracked paths under
    // execFile's default 1MB would throw ENOBUFS rather than return a partial
    // list.
    { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }
  );
  return parseStatus(stdout);
}

/** Every change, de-duplicated by path, for a count that matches the list. */
export function changeCount(status: RepoStatus): number {
  const paths = new Set<string>();
  for (const change of [...status.staged, ...status.unstaged, ...status.untracked]) {
    paths.add(change.path);
  }
  return paths.size;
}
