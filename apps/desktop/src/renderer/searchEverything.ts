/**
 * The title bar's search (item 127): what it finds and in what order.
 *
 * Kept free of React so it can be tested. It only ever searches what the app
 * already has — the loaded snapshot, the sessions, the file list ⌘P uses and
 * the app's own actions — and asks nothing of GitHub, Jira or Sentry as you
 * type.
 */
import { rankPaths } from '@kovan/core';

export type ScopeId = 'all' | 'pull' | 'ticket' | 'sentry' | 'session' | 'file' | 'action';

export const SCOPES: { id: ScopeId; label: string; group: string }[] = [
  { id: 'all', label: 'All', group: '' },
  { id: 'pull', label: 'Pull requests', group: 'Pull requests' },
  { id: 'ticket', label: 'Tickets', group: 'Tickets' },
  { id: 'sentry', label: 'Sentry', group: 'Sentry issues' },
  { id: 'session', label: 'Sessions', group: 'Sessions' },
  { id: 'file', label: 'Files', group: 'Files' },
  { id: 'action', label: 'Actions', group: 'Actions' }
];

export interface Candidate<T = unknown> {
  kind: Exclude<ScopeId, 'all'>;
  /** Unique within its kind. */
  id: string;
  /** The short tag on the left: `web #42`, `ACME-2393`, `TS`. */
  key: string;
  /** What is shown and highlighted. */
  title: string;
  /** Searched too, but not shown: repo, branch, status, folder. */
  extra?: string;
  /** Sorts a weaker candidate below an equal match (merged pull requests). */
  penalty?: number;
  data: T;
}

export interface Hit<T = unknown> {
  candidate: Candidate<T>;
  score: number;
  /** [start, end) ranges of `title` to highlight. */
  marks: [number, number][];
}

/**
 * Every word of the query somewhere in the title, key or extra, any order —
 * "retry pay" finds "Fix the flaky payment retry". Words at the start of the
 * title or of a word in it count for more.
 */
export function matchWords(query: string, c: Pick<Candidate, 'title' | 'key' | 'extra'>): { score: number; marks: [number, number][] } | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, marks: [] };
  const title = c.title.toLowerCase();
  const rest = `${c.key} ${c.extra ?? ''}`.toLowerCase();
  let score = 0;
  const marks: [number, number][] = [];
  for (const word of words) {
    const at = wordStart(title, word);
    if (at >= 0) {
      score += at === 0 ? 4 : 3;
      marks.push([at, at + word.length]);
      continue;
    }
    const inside = title.indexOf(word);
    if (inside >= 0) {
      score += 2;
      marks.push([inside, inside + word.length]);
      continue;
    }
    if (rest.includes(word)) {
      score += 1.5;
      continue;
    }
    return undefined;
  }
  return { score, marks: marks.sort((a, b) => a[0] - b[0]) };
}

/** The first place `word` starts a word of `text`, or -1. */
function wordStart(text: string, word: string): number {
  let at = text.indexOf(word);
  while (at >= 0) {
    if (at === 0 || /[^a-z0-9]/.test(text[at - 1]!)) return at;
    at = text.indexOf(word, at + 1);
  }
  return -1;
}

/**
 * The hits for `query` in `scope`, best first within each kind. `>` at the
 * start searches actions only, as VS Code's command prefix does. Files are
 * matched the way ⌘P matches them (fuzzy, on the path), everything else by
 * words.
 */
export function search<T>(rawQuery: string, scope: ScopeId, candidates: Candidate<T>[], perKind: number): { scope: ScopeId; hits: Hit<T>[] } {
  const command = rawQuery.trimStart().startsWith('>');
  const query = (command ? rawQuery.trimStart().slice(1) : rawQuery).trim();
  const effective: ScopeId = command ? 'action' : scope;
  const hits: Hit<T>[] = [];
  for (const { id: kind } of SCOPES) {
    if (kind === 'all' || (effective !== 'all' && effective !== kind)) continue;
    const pool = candidates.filter((c) => c.kind === kind);
    if (kind === 'file' && query) {
      for (const { item, match } of rankPaths(query, pool, (c) => c.title, perKind)) {
        hits.push({ candidate: item, score: match.score, marks: runs(match.indices) });
      }
      continue;
    }
    const scored: Hit<T>[] = [];
    for (const candidate of pool) {
      const m = matchWords(query, candidate);
      if (m) scored.push({ candidate, score: m.score - (candidate.penalty ?? 0), marks: m.marks });
    }
    // Stable: with no query, the order given (blocked first) is kept.
    scored.sort((a, b) => b.score - a.score);
    hits.push(...scored.slice(0, perKind));
  }
  return { scope: effective, hits };
}

/** Matched character positions as highlight ranges. */
function runs(indices: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** The next scope for ⇥ (or the previous one for ⇧⇥), wrapping. */
export function nextScope(scope: ScopeId, back = false): ScopeId {
  const i = SCOPES.findIndex((s) => s.id === scope);
  const n = SCOPES.length;
  return SCOPES[(i + (back ? n - 1 : 1)) % n]!.id;
}
