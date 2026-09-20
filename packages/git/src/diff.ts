/**
 * Unified diffs, parsed into something a view can render.
 *
 * The line numbers are the reason this is a parser rather than a `<pre>`. A
 * diff you can read tells you *where* in the file you are looking, and that
 * information exists only in the `@@` headers — every line after one has to be
 * counted forward from it, separately for the old side and the new, because a
 * `+` line advances only the new counter and a `-` line only the old.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number on the old side; absent for an added line. */
  old?: number;
  /** 1-based line number on the new side; absent for a removed line. */
  new?: number;
}

export interface DiffHunk {
  /** The `@@ … @@` line itself, including the trailing section heading. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Git declined to diff it; there is nothing textual to show. */
  binary: boolean;
  /** No hunks because the file genuinely has no changes on this side. */
  empty: boolean;
}

export const EMPTY_DIFF: FileDiff = {
  hunks: [],
  additions: 0,
  deletions: 0,
  binary: false,
  empty: true
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(raw: string): FileDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  // The trailing newline terminates the last line; it does not start one.
  for (const line of raw.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
      continue;
    }

    const match = HUNK.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }

    // Everything before the first `@@` is the `diff --git`/`index`/`---`/`+++`
    // preamble, which says nothing the view does not already know.
    if (!current) continue;

    const marker = line[0];
    if (marker === '+') {
      additions++;
      current.lines.push({ kind: 'add', text: line.slice(1), new: newLine++ });
    } else if (marker === '-') {
      deletions++;
      current.lines.push({ kind: 'del', text: line.slice(1), old: oldLine++ });
    } else if (marker === '\\') {
      // "\ No newline at end of file" — a real property of the file, and
      // dropping it would make the two sides look equal when they are not.
      current.lines.push({ kind: 'meta', text: line.slice(2) });
    } else if (marker === ' ') {
      // Verified against git rather than assumed: a context line that is
      // *itself* blank arrives as a bare " ", never as "". Accepting "" here
      // as well would swallow the empty string that the trailing newline
      // leaves behind and number a line that does not exist.
      current.lines.push({
        kind: 'context',
        text: line.slice(1),
        old: oldLine++,
        new: newLine++
      });
    }
  }

  return { hunks, additions, deletions, binary, empty: hunks.length === 0 && !binary };
}

export type DiffSide = 'staged' | 'unstaged' | 'untracked';

/**
 * The diff for one file.
 *
 * The three sides need three different commands, which is why this is not one
 * `git diff` call with a flag:
 *
 *   unstaged  working tree against the index
 *   staged    index against HEAD (`--cached`)
 *   untracked git has never seen the file, so there is nothing to diff it
 *             against — `--no-index` against /dev/null renders it as one big
 *             addition, which is what an untracked file *is*.
 *
 * `--no-index` exits 1 when the files differ, which is the normal case here,
 * so its non-zero exit is expected rather than an error.
 */
export async function readDiff(
  repo: string,
  file: string,
  side: DiffSide,
  /**
   * A rename's source path.
   *
   * Without it the pathspec names only the destination, so git has nothing to
   * pair the file with and renders a rename as a whole-file addition — every
   * line green, when in truth perhaps one line changed. Naming both paths lets
   * rename detection do its job.
   */
  from?: string,
  context = 3
): Promise<FileDiff> {
  const common = ['--no-color', '--no-ext-diff', `--unified=${context}`];
  const options = { cwd: repo, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 };

  if (side === 'untracked') {
    try {
      const { stdout } = await run(
        'git',
        ['-C', repo, 'diff', ...common, '--no-index', '--', '/dev/null', file],
        options
      );
      return parseDiff(stdout);
    } catch (error) {
      // Exit 1 with output on stdout is "they differ", not a failure.
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === 'string' && stdout.length > 0) {
        return parseDiff(stdout);
      }
      throw error;
    }
  }

  const args = ['-C', repo, 'diff', ...common, '--find-renames'];
  if (side === 'staged') args.push('--cached');
  args.push('--', file);
  if (from && from !== file) args.push(from);
  const { stdout } = await run('git', args, options);
  return parseDiff(stdout);
}
