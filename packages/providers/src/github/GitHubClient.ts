import type { CancelSignal } from '@baton/host';
import {
  buildPullSearch,
  checkRunStatus,
  graphqlEndpoint,
  reviewDecisionFrom,
  summaryFromApi,
  withinScope,
  type ApiPullNode,
  type PullSummary,
  type RepoRef,
  type ReviewDecision
} from '@baton/core';
import type { HttpClient } from '../http';

/** The pull request for the checked-out branch, with its review detail. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: string;
  headSha: string;
  reviewDecision: ReviewDecision;
  reviewComments: number;
  checks: { name: string; status: 'pending' | 'success' | 'failure' | 'neutral'; url: string }[];
  comments: {
    id: number;
    author: string;
    body: string;
    path?: string;
    line?: number;
    url: string;
    createdAt: string;
  }[];
  updatedAt: string;
}

export interface PullQueues {
  viewer: string;
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  /** The most recently merged, newest first. A window onto `mergedTotal`. */
  merged: PullSummary[];
  /**
   * How many merged pull requests match altogether.
   *
   * Without it "Show more" cannot say what it would show, and a list that
   * silently stops is a list you assume is complete.
   */
  mergedTotal: number;
  /** True when a repo scope had to be applied to the response instead of the query. */
  filteredClientSide: boolean;
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
  head: { sha: string };
  review_comments?: number;
  requested_reviewers?: ({ login?: string } | null)[] | null;
  updated_at: string;
}

const PULL_FIELDS = `
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  mergedAt
  headRefName
  additions
  deletions
  mergeable
  reviewDecision
  author { login }
  repository { nameWithOwner }
  viewerLatestReview { state }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const QUEUES_QUERY = `
query BatonPullQueues($mine: String!, $review: String!, $merged: String!,
                      $first: Int!, $mergedFirst: Int!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: $first) {
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
  review: search(query: $review, type: ISSUE, first: $first) {
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
  merged: search(query: $merged, type: ISSUE, first: $mergedFirst) {
    issueCount
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
}`;

/**
 * The merged queue on its own, for "Show more".
 *
 * Separate from QUEUES_QUERY on purpose: asking for ten more merged pull
 * requests should not re-fetch both open queues, and it must not be able to
 * fail them either — a rate limit hit while browsing history would otherwise
 * blank the list of things actually blocked on you.
 */
const MERGED_QUERY = `
query BatonMerged($merged: String!, $first: Int!) {
  merged: search(query: $merged, type: ISSUE, first: $first) {
    issueCount
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
}`;

/** `sort:` is part of the query because GitHub search has no order argument. */
const MERGED_SEARCH = 'is:pr is:merged author:@me sort:updated-desc';

/** What the merged list holds before anybody asks for more. */
export const MERGED_PAGE = 10;

interface MergedSearch {
  issueCount?: number;
  nodes?: (ApiPullNode | null)[] | null;
}

interface GraphResponse {
  data?: {
    viewer?: { login?: string };
    mine?: { nodes?: (ApiPullNode | null)[] | null };
    review?: { nodes?: (ApiPullNode | null)[] | null };
    merged?: MergedSearch | null;
  };
  errors?: { message: string }[];
}

export class GitHubClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /**
   * The pull request for one branch. `state=all` because a just-merged PR is
   * still the thing the user is looking at, and an open one is preferred when
   * the branch has been reused.
   */
  async findPullForBranch(
    owner: string,
    repo: string,
    branch: string,
    signal?: CancelSignal
  ): Promise<PullRequest | undefined> {
    const pulls = await this.http.json<RawPull[]>(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(
        `${owner}:${branch}`
      )}&state=all&per_page=5`,
      { headers: this.headers, signal }
    );
    const pull = pulls?.find((p) => p.state === 'open') ?? pulls?.[0];
    if (!pull) {
      return undefined;
    }

    // One slow call per aspect, but they are independent: a repo with checks
    // disabled shouldn't cost us the reviews.
    const [reviews, checks, comments] = await Promise.all([
      this.http
        .json<{ state: string; submitted_at: string; user?: { login?: string } }[]>(
          `${this.baseUrl}/repos/${owner}/${repo}/pulls/${pull.number}/reviews?per_page=100`,
          { headers: this.headers, signal }
        )
        .catch(() => []),
      this.http
        .json<{ check_runs?: { name: string; status: string; conclusion?: string | null; html_url: string }[] }>(
          `${this.baseUrl}/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs?per_page=50`,
          { headers: this.headers, signal }
        )
        .catch(() => ({ check_runs: [] })),
      this.http
        .json<
          {
            id: number;
            user?: { login?: string };
            body: string;
            path?: string;
            line?: number | null;
            html_url: string;
            created_at: string;
          }[]
        >(`${this.baseUrl}/repos/${owner}/${repo}/pulls/${pull.number}/comments?per_page=100`, {
          headers: this.headers,
          signal
        })
        .catch(() => [])
    ]);

    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.merged_at ? 'merged' : pull.draft ? 'draft' : (pull.state as 'open' | 'closed'),
      author: pull.user?.login ?? 'unknown',
      headSha: pull.head.sha,
      reviewDecision: reviewDecisionFrom(
        reviews ?? [],
        (pull.requested_reviewers ?? [])
          .map((reviewer) => reviewer?.login)
          .filter((login): login is string => Boolean(login))
      ),
      reviewComments: pull.review_comments ?? 0,
      checks: (checks.check_runs ?? []).map((run) => ({
        name: run.name,
        status: checkRunStatus(run),
        url: run.html_url
      })),
      comments: (comments ?? []).map((c) => ({
        id: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body,
        path: c.path,
        line: c.line ?? undefined,
        url: c.html_url,
        createdAt: c.created_at
      })),
      updatedAt: pull.updated_at
    };
  }

  /**
   * Both queues in a single GraphQL request.
   *
   * REST can't do this: its search results carry neither `mergeable` nor
   * `reviewDecision`, so a conflict badge would cost one extra request per pull
   * request and still be wrong until GitHub finished computing mergeability.
   */
  async pullQueues(
    /** `undefined` surveys the whole account. See buildPullSearch. */
    repos: readonly RepoRef[] | undefined,
    limit: number,
    signal?: CancelSignal,
    merged: number = MERGED_PAGE
  ): Promise<PullQueues> {
    const mineSearch = buildPullSearch('is:pr is:open author:@me', repos);
    const reviewSearch = buildPullSearch('is:pr is:open review-requested:@me', repos);
    const mergedSearch = buildPullSearch(MERGED_SEARCH, repos);

    const response = await this.http.json<GraphResponse>(graphqlEndpoint(this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json'
      },
      body: {
        query: QUEUES_QUERY,
        variables: {
          mine: mineSearch.query,
          review: reviewSearch.query,
          merged: mergedSearch.query,
          first: limit,
          mergedFirst: merged
        }
      },
      signal
    });

    // GraphQL answers 200 with an `errors` array, so a bad token or a missing
    // scope arrives looking like success unless it is checked here.
    if (response.errors?.length) {
      throw new Error(response.errors.map((e) => e.message).join('; '));
    }

    const read = (nodes: (ApiPullNode | null)[] | null | undefined): PullSummary[] =>
      (nodes ?? []).filter((n): n is ApiPullNode => Boolean(n?.number)).map(summaryFromApi);

    return {
      viewer: response.data?.viewer?.login ?? '',
      mine: withinScope(read(response.data?.mine?.nodes), mineSearch.allow),
      reviewRequested: withinScope(read(response.data?.review?.nodes), reviewSearch.allow),
      merged: withinScope(read(response.data?.merged?.nodes), mergedSearch.allow),
      // GitHub's count, not the scoped array's length: it is what "Show 10
      // more of 240" quotes, and it is also the only way to know that asking
      // again would return anything.
      mergedTotal: response.data?.merged?.issueCount ?? 0,
      filteredClientSide: mineSearch.filteredClientSide || reviewSearch.filteredClientSide
    };
  }

  /**
   * More of the merged list.
   *
   * Takes a total rather than a cursor because GitHub search pagination on a
   * moving result set skips and repeats: something merging between two pages
   * shifts everything down one. Re-asking for a bigger window costs one
   * request and cannot lose a row.
   */
  async mergedPulls(
    repos: readonly RepoRef[] | undefined,
    limit: number,
    signal?: CancelSignal
  ): Promise<{ pulls: PullSummary[]; total: number }> {
    const search = buildPullSearch(MERGED_SEARCH, repos);
    const response = await this.http.json<GraphResponse>(graphqlEndpoint(this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json'
      },
      body: { query: MERGED_QUERY, variables: { merged: search.query, first: limit } },
      signal
    });

    if (response.errors?.length) {
      throw new Error(response.errors.map((e) => e.message).join('; '));
    }

    const nodes = (response.data?.merged?.nodes ?? [])
      .filter((n): n is ApiPullNode => Boolean(n?.number))
      .map(summaryFromApi);

    return {
      pulls: withinScope(nodes, search.allow),
      total: response.data?.merged?.issueCount ?? 0
    };
  }

  async verify(signal?: CancelSignal): Promise<string> {
    const user = await this.http.json<{ login: string }>(`${this.baseUrl}/user`, {
      headers: this.headers,
      signal
    });
    return user.login;
  }
}
