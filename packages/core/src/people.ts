/**
 * Another person's pull requests and tickets (item 164): the person picker
 * beside the Pull requests and Tickets titles.
 */

import type { JiraIssue } from './types';
import type { PullSummary } from './github/pullStatus';

/** One person the picker lists. */
export interface Teammate {
  /** GitHub login, or Jira account id: what the lists are fetched by. */
  id: string;
  name: string;
  /** What to show beside the name in mono: the GitHub login. */
  handle?: string;
  /** Open pull requests, or open tickets, in what the picker looked at. */
  open: number;
}

/** A teammate's pull requests, in the shape of your own queues. */
export interface PersonPulls {
  /** Theirs, open, drafts included. */
  open: PullSummary[];
  /** Waiting on their review. */
  reviewRequested: PullSummary[];
  merged: PullSummary[];
  mergedTotal: number;
}

export interface PersonTickets {
  tickets: JiraIssue[];
}

/**
 * Everyone seen, most open first, then by name. Someone with nothing open
 * still shows: they are on the team, and "0" is the answer you came for.
 * `me` is left out, since "You" is always the list's first row.
 */
export function rankTeammates(
  seen: readonly { id: string; name: string; handle?: string; open: boolean }[],
  me: readonly string[]
): Teammate[] {
  const skip = new Set(me.filter(Boolean).map((id) => id.toLowerCase()));
  const byId = new Map<string, Teammate>();
  for (const entry of seen) {
    if (!entry.id || skip.has(entry.id.toLowerCase())) continue;
    const found = byId.get(entry.id) ?? { id: entry.id, name: entry.name || entry.handle || entry.id, ...(entry.handle ? { handle: entry.handle } : {}), open: 0 };
    if (entry.open) found.open += 1;
    byId.set(entry.id, found);
  }
  return [...byId.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

/** Whether a string can be a GitHub login: what goes into `author:` unquoted. */
export function isGitHubLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login);
}

export const DEFAULT_TASKS_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/**
 * Your ticket query, asked about someone else: every `currentUser()` becomes
 * their account id, so their list follows the same rules as yours. A query
 * that never names you can't be turned into theirs, and the default is asked
 * instead.
 */
export function personJql(configured: string, accountId: string): string {
  const quoted = `"${accountId.replace(/["\\]/g, '')}"`;
  const pattern = /currentUser\(\s*\)/gi;
  const source = pattern.test(configured) ? configured : DEFAULT_TASKS_JQL;
  return source.replace(/currentUser\(\s*\)/gi, quoted);
}

/** The project keys of these tickets (`ACME-12` → `ACME`), each once. */
export function projectKeys(tickets: readonly { key: string }[]): string[] {
  return [...new Set(tickets.map((t) => t.key.split('-')[0] ?? '').filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)))];
}
