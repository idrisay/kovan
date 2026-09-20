/**
 * The full picture of one pull request.
 *
 * Deliberately separate from the queue query: this costs a round trip and is
 * only wanted when somebody opens a row, while the queues are fetched every
 * refresh for everything. Putting the review threads in the queue query would
 * make the poll several times more expensive for data nobody is looking at.
 */

import type { CancelSignal } from '@baton/host';
import { graphqlEndpoint } from '@baton/core';
import type { HttpClient } from '../http';

export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  comments: ReviewComment[];
}

export interface CheckRun {
  name: string;
  status: 'pending' | 'success' | 'failure' | 'neutral';
  url?: string;
}

export interface PullDetail {
  number: number;
  repo: string;
  title: string;
  url: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Review threads, unresolved first — those are what is blocking. */
  threads: ReviewThread[];
  /** Top-level conversation, which is not the same as review threads. */
  comments: ReviewComment[];
  checks: CheckRun[];
  files: { path: string; additions: number; deletions: number; status: string }[];
}

const DETAIL_QUERY = `
query BatonPullDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url body additions deletions changedFiles
      author { login }
      baseRefName headRefName
      comments(last: 50) {
        nodes { author { login } body createdAt url }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated
          comments(first: 50) {
            nodes { author { login } body createdAt path line url }
          }
        }
      }
      files(first: 100) {
        nodes { path additions deletions changeType }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  path?: string | null;
  line?: number | null;
  url?: string;
}

function comment(raw: RawComment | null): ReviewComment | undefined {
  if (!raw) return undefined;
  return {
    author: raw.author?.login ?? 'unknown',
    body: raw.body ?? '',
    createdAt: raw.createdAt ?? '',
    path: raw.path ?? undefined,
    line: raw.line ?? undefined,
    url: raw.url ?? ''
  };
}

/** GraphQL reports CheckRun and StatusContext differently; both mean "a check". */
function checkFrom(node: Record<string, unknown>): CheckRun | undefined {
  if (typeof node['name'] === 'string') {
    const status = node['status'] === 'COMPLETED' ? conclusion(node['conclusion']) : 'pending';
    return { name: node['name'], status, url: (node['detailsUrl'] as string) ?? undefined };
  }
  if (typeof node['context'] === 'string') {
    return {
      name: node['context'],
      status: conclusion(node['state']),
      url: (node['targetUrl'] as string) ?? undefined
    };
  }
  return undefined;
}

function conclusion(value: unknown): CheckRun['status'] {
  switch (String(value).toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
    case 'IN_PROGRESS':
    case 'QUEUED':
      return 'pending';
    default:
      return 'neutral';
  }
}

export async function fetchPullDetail(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string,
  number: number,
  signal?: CancelSignal
): Promise<PullDetail> {
  const [owner, name] = repo.split('/');
  const response = await http.json<{
    data?: { repository?: { pullRequest?: Record<string, any> } };
    errors?: { message: string }[];
  }>(graphqlEndpoint(baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: { query: DETAIL_QUERY, variables: { owner, name, number } },
    signal
  });

  // GraphQL answers 200 with an `errors` array, so a bad token or a missing
  // scope arrives looking like success unless it is checked here.
  if (response.errors?.length) {
    throw new Error(response.errors.map((e) => e.message).join('; '));
  }
  const pull = response.data?.repository?.pullRequest;
  if (!pull) {
    throw new Error(`${repo}#${number} not found`);
  }

  const threads: ReviewThread[] = (pull['reviewThreads']?.nodes ?? [])
    .filter(Boolean)
    .map((thread: any) => {
      const comments = (thread.comments?.nodes ?? [])
        .map(comment)
        .filter((c: ReviewComment | undefined): c is ReviewComment => Boolean(c));
      return {
        id: thread.id,
        isResolved: Boolean(thread.isResolved),
        isOutdated: Boolean(thread.isOutdated),
        path: comments[0]?.path,
        line: comments[0]?.line,
        comments
      };
    })
    // Unresolved first: those are what is blocking, and a long list of
    // resolved threads above them buries the reason you opened this.
    .sort((a: ReviewThread, b: ReviewThread) => Number(a.isResolved) - Number(b.isResolved));

  const checkNodes =
    pull['commits']?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  return {
    number: pull['number'],
    repo,
    title: pull['title'] ?? '',
    url: pull['url'] ?? '',
    body: pull['body'] ?? '',
    author: pull['author']?.login ?? 'unknown',
    baseRef: pull['baseRefName'] ?? '',
    headRef: pull['headRefName'] ?? '',
    additions: pull['additions'] ?? 0,
    deletions: pull['deletions'] ?? 0,
    changedFiles: pull['changedFiles'] ?? 0,
    threads,
    comments: (pull['comments']?.nodes ?? [])
      .map(comment)
      .filter((c: ReviewComment | undefined): c is ReviewComment => Boolean(c)),
    checks: checkNodes.map(checkFrom).filter(Boolean) as CheckRun[],
    files: (pull['files']?.nodes ?? []).filter(Boolean).map((f: any) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: String(f.changeType ?? '').toLowerCase()
    }))
  };
}
