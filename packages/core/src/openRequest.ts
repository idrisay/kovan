/**
 * "Open in Kovan" from the pane beside Claude (item 148). The pane can't reach
 * Kovan's window, so it writes a request into a folder Kovan watches, the way
 * agent status reaches it (item 112), and Kovan writes a one-line reply the
 * pane shows as a toast.
 *
 * A request comes from a process Kovan started but doesn't control, so it is
 * read as untrusted: absolute paths only, the file inside the repository, and
 * the repository must still be one of Kovan's workspace folders (checked in
 * main, against the disk).
 */

export interface OpenRequest {
  /** The repository's root, absolute. */
  repo: string;
  /** The file, relative to `repo`, with forward slashes and no `..`. */
  file: string;
}

export interface OpenReply {
  ok: boolean;
  message: string;
}

/** The request a file holds, or undefined when it isn't one. */
export function parseOpenRequest(text: string): OpenRequest | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!raw || typeof raw !== 'object') return undefined;
  const { repo, file } = raw as Record<string, unknown>;
  if (typeof repo !== 'string' || typeof file !== 'string') return undefined;
  if (!repo.startsWith('/') || !file.startsWith('/')) return undefined;
  const root = repo.replace(/\/+$/, '');
  if (!root || !file.startsWith(`${root}/`)) return undefined;
  const rel = file.slice(root.length + 1);
  if (!rel || rel.split('/').some((part) => part === '..' || part === '.' || part === '')) return undefined;
  if (/[\0\n]/.test(rel) || /[\0\n]/.test(root)) return undefined;
  return { repo: root, file: rel };
}

/** Which of the Workspace's diffs shows the file's changes now; undefined when it has none. */
export function diffSideFor(
  status: { staged: { path: string }[]; unstaged: { path: string }[]; untracked: { path: string }[] },
  file: string
): 'staged' | 'unstaged' | 'untracked' | undefined {
  if (status.untracked.some((c) => c.path === file)) return 'untracked';
  if (status.unstaged.some((c) => c.path === file)) return 'unstaged';
  if (status.staged.some((c) => c.path === file)) return 'staged';
  return undefined;
}
