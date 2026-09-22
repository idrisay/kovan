/**
 * Types that cross package boundaries.
 *
 * These lived inside the VS Code extension's client and config files, which
 * meant importing a `vscode`-coupled module just to name a Jira issue. Pulled
 * out here so `@baton/core` stays platform-free and `@baton/providers` has
 * something to implement against.
 */

export type ProviderId = 'jira' | 'figma' | 'sentry' | 'github' | 'grafana';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'github',
  'jira',
  'sentry',
  'grafana',
  'figma'
];

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  /** ISO timestamp of the last change, used by the task list's sort. */
  updated: string;
  url: string;
  subtasks: { key: string; summary: string; status: string; url: string }[];
  comments: { author: string; body: string; created: string }[];
  /** Every URL found anywhere in the issue — the Figma provider mines these. */
  links: string[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: string;
}

export interface PathMapping {
  from: string;
  to: string;
}

export interface SentryIssue {
  id: string;
  /** The short, human-quotable form — `PROJ-1A2` — Sentry's own UI uses. */
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
  permalink: string;
  project: string;
  firstSeen: string;
  lastSeen: string;
}

/**
 * One stack frame. Fetched separately from the issue itself — Sentry's own
 * API has no stack trace on the issue, only on its latest event — so this is
 * never part of a `SentryIssue`, only ever the answer to asking for one
 * issue's own frames.
 */
export interface SentryFrame {
  filename?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  inApp: boolean;
  /** The real path on disk, when `resolveFrame()` could place it. */
  resolvedPath?: string;
}

export interface GrafanaAlert {
  name: string;
  state: string;
  severity: string;
  activeSince?: string;
  labels: Record<string, string>;
}

export interface FigmaFrame {
  name: string;
  key: string;
  nodeId: string;
  width: number;
  height: number;
  imageUrl?: string;
}
