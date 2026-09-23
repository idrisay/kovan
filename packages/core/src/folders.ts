/**
 * A run across more than one folder — a change that spans the frontend and
 * the backend, say. The agent starts in the first folder; the others are
 * opened to it where its CLI can (`--add-dir`) and named in the prompt either
 * way, so an agent without the flag still knows where to look.
 */

import { modelFamily } from './modelSearch';

export interface RunFolder {
  label: string;
  path: string;
}

/**
 * `--add-dir=<path>` per extra folder, for Claude Code and Codex. The `=`
 * form on purpose: Claude Code's `--add-dir` takes a list, and written as
 * separate words it would swallow the prompt that follows it as one more
 * directory.
 */
export function extraDirArgs(command: string, paths: readonly string[]): string[] {
  const family = modelFamily(command);
  if (family !== 'claude' && family !== 'codex') return [];
  return paths.map((p) => `--add-dir=${p}`);
}

/** Appended to the prompt when a run has more than one folder. */
export function foldersPromptSection(main: RunFolder, extras: readonly RunFolder[]): string {
  if (extras.length === 0) return '';
  return [
    '',
    '## Folders',
    '',
    `This work spans more than one repository. You are started in ${main.label} (${main.path}).`,
    'The change also involves:',
    ...extras.map((f) => `- ${f.label} — ${f.path}`),
    '',
    'Read and change each one as the work needs, and keep their changes consistent with each other.',
    'Each is its own git repository: branch, commit and open pull requests in each one separately.'
  ].join('\n');
}
