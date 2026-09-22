/**
 * Discarding a tracked file's changes back to HEAD.
 *
 * Split from `status.ts`/`diff.ts` because reverting, unlike reading, has to
 * be exact about *how much* of git's state it touches — get this wrong and
 * "roll back this change" either does nothing or eats someone else's work.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * `staged` and `unstaged` are the only sides this ever runs for — an
 * untracked file has no git state to restore, so the caller deletes it
 * directly instead of calling this.
 */
export type RevertSide = 'staged' | 'unstaged';

/**
 * Restores `paths` in `repo` to how HEAD has them.
 *
 *   staged    resets both the index *and* the working tree. There is no
 *             git operation that unstages a path while leaving its working
 *             tree content discarded too without doing both — and doing only
 *             `--staged` would turn "revert this" into "unstage this",
 *             leaving the same edit sitting there relabelled as unstaged
 *             instead of gone. This is the same choice VS Code's and GitHub
 *             Desktop's "Discard Changes" make for a staged file.
 *   unstaged  resets only the working tree, leaving a staged version of the
 *             same path (if the file is partially staged, and so has a
 *             separate row of its own) untouched.
 *
 * `git restore` also recreates a path git shows as deleted and removes one
 * git shows as newly added-then-modified, so callers do not need to special
 * case those kinds.
 */
export async function revertTracked(repo: string, paths: readonly string[], side: RevertSide): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const args = [
    '-C', repo, 'restore',
    ...(side === 'staged' ? ['--staged', '--worktree'] : ['--worktree']),
    '--', ...paths
  ];
  await run('git', args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
}
