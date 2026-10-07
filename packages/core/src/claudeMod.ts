/**
 * Kovan's Claude Code mod (item 147): the pane beside a Claude session with
 * the goal, the plan, the files changed and their diffs, the checks and the
 * usage. The mod lives in the app's resources; this decides what a session
 * is told about its goal and when the mod is loaded at all.
 */

import { modelFamily } from './modelSearch';

/** What the pane's Goal line says: the title, and the key or number it goes by. */
export interface ModGoal {
  goal: string;
  key: string;
}

/**
 * The goal of a session started from a pull request, a ticket or a Sentry
 * issue. A ticket wins over a pull request because it says what was asked
 * for; a pull request says what was done.
 */
export function modGoal(subject: {
  pull?: { repo: string; number: number; title: string };
  issue?: { key: string; summary: string };
  sentry?: { issue: { shortId: string; title: string } };
}): ModGoal | undefined {
  if (subject.issue) return { goal: subject.issue.summary, key: subject.issue.key };
  if (subject.pull) return { goal: subject.pull.title, key: `${subject.pull.repo.split('/').pop()}#${subject.pull.number}` };
  if (subject.sentry) return { goal: subject.sentry.issue.title, key: subject.sentry.issue.shortId };
  return undefined;
}

/** The environment a session hands the mod: one short line each, as the pane draws them. */
export function modEnv(goal: ModGoal | undefined): Record<string, string> {
  if (!goal) return {};
  const oneLine = (s: string, max: number) => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  return { KOVAN_GOAL: oneLine(goal.goal, 200), KOVAN_GOAL_KEY: oneLine(goal.key, 60) };
}

/** `--plugin-dir <mod>` for a Claude command; nothing for any other agent. */
export function modArgs(command: string, modDir: string | undefined): string[] {
  return modDir && modelFamily(command) === 'claude' ? ['--plugin-dir', modDir] : [];
}
