/**
 * Connection problems (item 120, option B): a service that didn't answer,
 * said in words, with a history you can go back to.
 *
 * Pure: `trackProblems` takes the log so far and what one refresh returned,
 * and says what's open, what cleared, and what just started. Main keeps the
 * log on disk; the status bar shows it.
 */

import type { ProviderId } from './types';

export interface Problem {
  /** Stable for the life of the problem: provider + when it started. */
  id: string;
  provider: ProviderId;
  /** "Sentry didn't answer". */
  title: string;
  /** "within 15 s". */
  detail: string;
  /** The service's own message, for Copy details. */
  raw: string;
  startedAt: number;
  /** The last refresh that still failed this way. */
  lastAt: number;
  /** How many refreshes failed this way. */
  count: number;
  /** When a refresh of that service worked again. */
  clearedAt?: number;
}

const NAMES: Record<ProviderId, string> = {
  github: 'GitHub', jira: 'Jira', sentry: 'Sentry', grafana: 'Grafana', figma: 'Figma'
};

/** How many problems, open and earlier, are kept. */
export const PROBLEM_LIMIT = 50;

/** The service's error, in words: what went wrong and a hint of why. */
export function describeProblem(provider: ProviderId, raw: string): { title: string; detail: string } {
  const name = NAMES[provider] ?? provider;
  const timeout = /timed out after (\d+)\s*ms/i.exec(raw);
  if (timeout) return { title: `${name} didn't answer`, detail: `within ${Math.round(Number(timeout[1]) / 1000)} s` };
  if (/\b401\b|unauthori[sz]ed|bad credentials|token (was )?(rejected|invalid|expired)/i.test(raw)) {
    return { title: `${name} rejected the token`, detail: 'check it in Settings' };
  }
  if (/\b403\b|forbidden/i.test(raw)) return { title: `${name} refused access`, detail: 'the token may be missing a permission' };
  if (/\b429\b|rate.?limit/i.test(raw)) return { title: `${name} is rate limiting Kovan`, detail: 'too many requests; it waits and tries again' };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|network|fetch failed|offline|socket hang up/i.test(raw)) {
    return { title: `${name} couldn't be reached`, detail: 'no network, or the service is down' };
  }
  const server = /\b(5\d\d)\b/.exec(raw);
  if (server) return { title: `${name} had a server error`, detail: `HTTP ${server[1]}; usually passes` };
  const plain = raw.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return { title: `${name} failed`, detail: plain.length > 140 ? `${plain.slice(0, 139)}…` : plain || 'no reason given' };
}

/**
 * One refresh's outcome folded into the log.
 *
 * @param errors   the services that failed this time, with their messages
 * @param answered the services that answered this time
 * @param at       when the refresh happened: a problem counts one failure per refresh
 */
export function trackProblems(
  log: readonly Problem[],
  errors: readonly { provider: ProviderId; message: string }[],
  answered: readonly ProviderId[],
  at: number
): { log: Problem[]; started: Problem[] } {
  const next = log.map((p) => ({ ...p }));
  const started: Problem[] = [];
  const open = (provider: ProviderId) => next.find((p) => p.provider === provider && p.clearedAt === undefined);

  for (const error of errors) {
    const words = describeProblem(error.provider, error.message);
    const current = open(error.provider);
    if (current && current.title === words.title) {
      if (at > current.lastAt) {
        current.count += 1;
        current.lastAt = at;
      }
      current.detail = words.detail;
      current.raw = error.message;
      continue;
    }
    // A different failure from the same service is a new problem.
    if (current) current.clearedAt = at;
    const problem: Problem = {
      id: `${error.provider}:${at}`, provider: error.provider, ...words, raw: error.message,
      startedAt: at, lastAt: at, count: 1
    };
    next.unshift(problem);
    started.push(problem);
  }

  for (const provider of answered) {
    if (errors.some((e) => e.provider === provider)) continue;
    const current = open(provider);
    if (current) current.clearedAt = at;
  }

  next.sort((a, b) => b.startedAt - a.startedAt);
  return { log: next.slice(0, PROBLEM_LIMIT), started };
}
