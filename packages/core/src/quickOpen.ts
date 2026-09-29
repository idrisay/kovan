/**
 * ⌘P quick open (item 100): the matching, as VS Code's file picker does it.
 * Pure, so it is tested here and runs in the renderer on every keystroke.
 */

export interface QuickQuery {
  /** What to match against file paths. */
  text: string;
  /** "file.ts:42" — the line to go to once the file opens. */
  line?: number;
}

/** "src/app.ts:42" → { text: "src/app.ts", line: 42 }. A colon with no
 *  number after it is simply dropped, as it is while you are still typing. */
export function parseQuickQuery(raw: string): QuickQuery {
  const trimmed = raw.trim();
  const match = /^(.*?):(\d*)$/.exec(trimmed);
  if (!match) return { text: trimmed };
  const line = Number(match[2]);
  return match[2] && line > 0 ? { text: match[1]!.trim(), line } : { text: match[1]!.trim() };
}

export interface QuickMatch {
  score: number;
  /** Positions in the path that matched, for highlighting. */
  indices: number[];
}

const SEPARATOR = /[/\\\-_. ]/;

/**
 * Fuzzy-matches `query` against a relative path: every query character must
 * appear in order. Matches in the file name beat matches in the folders, a
 * run of consecutive characters beats scattered ones, and a match at the
 * start of a word (after `/`, `-`, `_`, `.` or a lower→upper change) beats
 * one in the middle. Spaces in the query are ignored, so "work tsx" finds
 * `Workspace.tsx`. undefined when it does not match at all.
 */
export function matchPath(query: string, path: string): QuickMatch | undefined {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const lower = path.toLowerCase();
  const nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;

  // Prefer a match that lies wholly inside the file name: try it first.
  const inName = greedy(q, lower, nameStart);
  const indices = inName ?? greedy(q, lower, 0);
  if (!indices) return undefined;

  let score = 0;
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i]!;
    score += 1;
    if (at >= nameStart) score += 2;
    if (i > 0 && indices[i - 1] === at - 1) score += 3;
    const before = path[at - 1];
    if (at === nameStart || before === undefined || SEPARATOR.test(before) ||
      (before === before.toLowerCase() && path[at] !== path[at]!.toLowerCase())) {
      score += 2;
    }
  }
  // The whole query as a substring of the name, and a short path, are both
  // what someone typing a file name means.
  if (lower.slice(nameStart).includes(q)) score += 6;
  if (lower.slice(nameStart).startsWith(q)) score += 4;
  score -= path.length / 100;
  return { score, indices };
}

/** Leftmost in-order match of `q` in `text` from `from`, preferring
 *  word starts; undefined when the characters aren't all there. */
function greedy(q: string, text: string, from: number): number[] | undefined {
  const out: number[] = [];
  let at = from;
  for (const ch of q) {
    const found = text.indexOf(ch, at);
    if (found < 0) return undefined;
    out.push(found);
    at = found + 1;
  }
  return out;
}

export interface RankedPath<T> {
  item: T;
  match: QuickMatch;
}

/** The best `limit` of `items` for `query`, best first. */
export function rankPaths<T>(query: string, items: readonly T[], pathOf: (item: T) => string, limit = 60): RankedPath<T>[] {
  const out: RankedPath<T>[] = [];
  for (const item of items) {
    const match = matchPath(query, pathOf(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score || pathOf(a.item).length - pathOf(b.item).length);
  return out.slice(0, limit);
}

/** A recently-opened list after opening `path`: it moves to the front,
 *  nothing is listed twice, and the list stays at `max`. */
export function pushRecent(list: readonly string[], path: string, max = 50): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}
