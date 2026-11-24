/**
 * The prompts an agent is started with, as Settings › Prompts edits them
 * (item 181).
 *
 * Each kind has a built-in text in `prompts.ts` and an optional override in
 * settings (`prompt.template.<kind>`): empty means the built-in text, which
 * is how main already reads them. This module is the catalogue the editor
 * needs on top: what each kind is for, which `${…}` placeholders it fills and
 * what they become, a check for names it doesn't know (a typo there reaches
 * the agent as literal text, see `substitute`), and a preview rendered with
 * example data.
 */

import type { PullSummary } from './github/pullStatus';
import {
  DEFAULT_CONVENTIONS, DEFAULTGROUPREVIEWTEMPLATE, DEFAULTISSUETEMPLATE, DEFAULTREVIEWTEMPLATE, DEFAULTSENTRYTEMPLATE,
  DEFAULTUPDATETEMPLATE, DEFAULTVERIFYTEMPLATE, renderGroupReviewPrompt, renderIssuePrompt, renderPullPrompt,
  renderSentryPrompt, renderVerifyPrompt, type Conventions
} from './prompts';

export type PromptKind = 'implement' | 'sentry' | 'review' | 'groupReview' | 'unblock' | 'verify';

export interface PromptPlaceholder {
  name: string;
  /** What it becomes, in a few words. */
  means: string;
}

export interface PromptTemplateInfo {
  kind: PromptKind;
  title: string;
  /** Where in Kovan this prompt starts an agent. */
  usedBy: string;
  /** The settings key holding the override; empty means the built-in text. */
  settingKey: string;
  builtIn: string;
  placeholders: readonly PromptPlaceholder[];
}

// --- Placeholders, shared where the renderers share them --------------------

const SHARED: readonly PromptPlaceholder[] = [
  { name: 'reviewers', means: 'A line asking the reviewers picked in the run sheet to review the result, or nothing' },
  { name: 'attribution', means: 'Kovan\'s rule: everything external is written as you, with no AI attribution' },
  { name: 'report', means: 'Kovan\'s rule for the run\'s record ($KOVAN_REPORT, screenshots, status). Kovan reads it back' }
];

const CONVENTIONS: readonly PromptPlaceholder[] = [
  { name: 'base', means: 'The base branch, from Shared values below' },
  { name: 'checks', means: 'The checks that must pass, from Shared values below' },
  { name: 'prReviewers', means: '"Request a review from … on the pull request.", from Shared values below, or nothing' }
];

const UNTOUCHABLE: PromptPlaceholder = { name: 'untouchable', means: '"Do not edit …", from Shared values below, or nothing' };

const PULL: readonly PromptPlaceholder[] = [
  { name: 'url', means: 'The pull request\'s address' },
  { name: 'repo', means: 'owner/name' },
  { name: 'number', means: 'Its number' },
  { name: 'title', means: 'Its title' },
  { name: 'author', means: 'Who opened it' },
  { name: 'state', means: 'What is blocking it, in the row\'s words' },
  { name: 'key', means: 'The ticket key in its title, if any' }
];

export const PROMPT_TEMPLATES: readonly PromptTemplateInfo[] = [
  {
    kind: 'implement',
    title: 'Implement a ticket',
    usedBy: 'Work on in an agent, on a Jira ticket',
    settingKey: 'prompt.template.implement',
    builtIn: DEFAULTISSUETEMPLATE,
    placeholders: [
      { name: 'url', means: 'The ticket\'s address' },
      { name: 'key', means: 'Its key, e.g. PROJ-123' },
      { name: 'summary', means: 'Its title' },
      { name: 'description', means: 'Its description' },
      { name: 'status', means: 'Its status' },
      { name: 'type', means: 'Its issue type' },
      { name: 'priority', means: 'Its priority' },
      ...CONVENTIONS, UNTOUCHABLE, ...SHARED
    ]
  },
  {
    kind: 'sentry',
    title: 'Fix a Sentry error',
    usedBy: 'Fix in an agent, on a Sentry issue',
    settingKey: 'prompt.template.sentry',
    builtIn: DEFAULTSENTRYTEMPLATE,
    placeholders: [
      { name: 'shortId', means: 'Its short ID, e.g. PROJ-1A2' },
      { name: 'title', means: 'The error' },
      { name: 'permalink', means: 'Its address in Sentry' },
      { name: 'level', means: 'error, warning…' },
      { name: 'culprit', means: 'Where Sentry says it surfaced' },
      { name: 'count', means: 'How many times it was seen' },
      { name: 'userCount', means: 'How many users it hit' },
      { name: 'firstSeen', means: 'When it was first seen' },
      { name: 'lastSeen', means: 'When it was last seen' },
      { name: 'frames', means: 'The stack trace, one line per frame' },
      ...CONVENTIONS, ...SHARED
    ]
  },
  {
    kind: 'review',
    title: 'Review a pull request',
    usedBy: 'Review in an agent, on a pull request',
    settingKey: 'prompt.template.review',
    builtIn: DEFAULTREVIEWTEMPLATE,
    placeholders: [...PULL, ...CONVENTIONS, UNTOUCHABLE, ...SHARED]
  },
  {
    kind: 'groupReview',
    title: 'Review pull requests together',
    usedBy: 'Review together, on a ticket with several pull requests',
    settingKey: 'prompt.template.groupReview',
    builtIn: DEFAULTGROUPREVIEWTEMPLATE,
    placeholders: [
      { name: 'count', means: 'How many pull requests' },
      { name: 'key', means: 'The ticket they implement' },
      { name: 'pulls', means: 'One line per pull request, with what you said on it before' },
      { name: 'context', means: 'The ticket\'s merged pull requests, to read but not review, or nothing' },
      { name: 'reviewers', means: 'A line asking the picked reviewers to review each one, or nothing' },
      { name: 'attribution', means: SHARED[1]!.means },
      { name: 'report', means: SHARED[2]!.means }
    ]
  },
  {
    kind: 'unblock',
    title: 'Unblock a pull request',
    usedBy: 'Unblock in an agent, on your blocked pull request',
    settingKey: 'prompt.template.unblock',
    builtIn: DEFAULTUPDATETEMPLATE,
    placeholders: [...PULL, ...CONVENTIONS, UNTOUCHABLE, ...SHARED]
  },
  {
    kind: 'verify',
    title: 'Check it shipped',
    usedBy: 'Check it shipped, on a merged pull request',
    settingKey: 'prompt.template.verify',
    builtIn: DEFAULTVERIFYTEMPLATE,
    placeholders: [
      ...PULL,
      { name: 'env', means: 'The environment\'s name, e.g. Dev' },
      { name: 'site', means: 'Its address' },
      { name: 'accounts', means: 'Who the agent can sign in as (added at the end if left out)' },
      { name: 'basicAuth', means: 'How to pass a Basic Auth wall, when the environment has one' },
      { name: 'verdicts', means: 'The four VERDICT lines the report must start with' },
      ...CONVENTIONS, UNTOUCHABLE, ...SHARED
    ]
  }
];

export function promptTemplate(kind: PromptKind): PromptTemplateInfo {
  return PROMPT_TEMPLATES.find((t) => t.kind === kind)!;
}

/** Every `${name}` in `text`, in order, each once. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!))];
}

/**
 * Names `kind` won't fill. Each would reach the agent as literal text, the
 * way `substitute` leaves an unknown placeholder, so the editor says so.
 */
export function unknownPlaceholders(kind: PromptKind, text: string): string[] {
  const known = new Set(promptTemplate(kind).placeholders.map((p) => p.name));
  return placeholdersIn(text).filter((name) => !known.has(name));
}

/**
 * What a customised prompt has dropped that Kovan relies on: `${report}` is
 * how a run leaves the record Kovan reads back into the ticket's file.
 */
export function missingPlaceholders(kind: PromptKind, text: string): string[] {
  const used = new Set(placeholdersIn(text));
  return promptTemplate(kind).builtIn.includes('${report}') && !used.has('report') ? ['report'] : [];
}

/**
 * A short fingerprint of a built-in text, kept beside an override so the
 * editor can tell you when the built-in prompt changed after you customised
 * it (a customised prompt never picks up those changes by itself).
 */
export function promptFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// --- Preview -----------------------------------------------------------------

const SAMPLE_PULL: PullSummary = {
  number: 412,
  title: 'feat/PROJ-2829 Show lesson progress on the dashboard',
  url: 'https://github.com/acme/web/pull/412',
  repo: 'acme/web',
  author: 'octocat',
  isDraft: false,
  createdAt: '2026-11-20T09:00:00Z',
  updatedAt: '2026-11-24T09:00:00Z',
  mergeable: 'mergeable',
  reviewDecision: 'changes_requested',
  checks: 'failure',
  unresolvedThreads: 2,
  additions: 120,
  deletions: 14,
  viewerReviewed: false
};

/**
 * `text` as an agent would receive it for `kind`, on example data and your
 * shared values. The reviewers line shows one example reviewer, so you can
 * see where it lands.
 */
export function previewPrompt(kind: PromptKind, text: string, conventions: Partial<Conventions> = {}): string {
  const shared = { ...DEFAULT_CONVENTIONS, ...conventions };
  const reviewers = ['an example reviewer'];
  switch (kind) {
    case 'implement':
      return renderIssuePrompt({
        key: 'PROJ-2829', summary: 'Show lesson progress on the dashboard', description: 'Teachers want to see…',
        status: 'In Progress', statusCategory: 'indeterminate', issueType: 'Story', priority: 'Medium', updated: '',
        url: 'https://example.atlassian.net/browse/PROJ-2829', subtasks: [], comments: [], links: []
      }, { template: text, reviewers, conventions: shared });
    case 'sentry':
      return renderSentryPrompt({
        id: '1', shortId: 'WEB-1A2', title: "TypeError: Cannot read properties of undefined (reading 'id')",
        culprit: 'app/lessons/progress.ts', level: 'error', count: 48, userCount: 12,
        permalink: 'https://sentry.io/organizations/acme/issues/1/', project: 'web',
        firstSeen: '2026-11-22T08:00:00Z', lastSeen: '2026-11-24T08:00:00Z'
      }, [
        { filename: 'app/lessons/page.tsx', function: 'LessonPage', lineNo: 40, inApp: true },
        { filename: 'app/lessons/progress.ts', function: 'progressOf', lineNo: 12, inApp: true }
      ], { template: text, reviewers, conventions: shared });
    case 'groupReview':
      return renderGroupReviewPrompt('PROJ-2829', [
        { pull: SAMPLE_PULL },
        { pull: { ...SAMPLE_PULL, repo: 'acme/api', number: 88, url: 'https://github.com/acme/api/pull/88', title: 'PROJ-2829 Progress endpoint' } }
      ], { reviewers, template: text });
    case 'verify':
      return renderVerifyPrompt(text, SAMPLE_PULL, { name: 'Dev', site: 'https://dev.example.com', accounts: [] }, { reviewers, conventions: shared });
    case 'review':
    case 'unblock':
      return renderPullPrompt(text, SAMPLE_PULL, { reviewers, conventions: shared });
  }
}
