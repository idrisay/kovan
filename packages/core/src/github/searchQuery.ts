import { repoSlug, type RepoRef } from './remoteUrl';

export interface PullSearch {
  /** The search string to send. */
  query: string;
  /**
   * `owner/name`, lowercased, of every repository the caller will accept.
   * Applied to the response regardless of what went into `query`.
   *
   * `undefined` means unscoped — accept every repository. That is distinct
   * from an empty set, which means "scoped to nothing" and accepts none. The
   * two hosts need opposite answers for "no repositories", so the distinction
   * cannot be inferred from emptiness: in the extension an empty workspace
   * legitimately shows nothing, while the desktop app's default is to survey
   * the whole account.
   */
  allow: Set<string> | undefined;
  /** True when the repositories did not fit in `query` and only `allow` scopes the result. */
  filteredClientSide: boolean;
}

/**
 * GitHub rejects a search query over 256 characters, and `repo:` qualifiers are
 * what push it over: six repositories already cost about 170 of them. So the
 * scope is enforced twice — narrowed in the query when it fits, and always
 * checked against `allow` on the way back.
 *
 * That redundancy is deliberate. Correctness never depends on the query string,
 * which means adding a seventh repository degrades to a slightly larger
 * response rather than to a 422 or, worse, to someone else's pull requests
 * appearing in the list.
 */
export function buildPullSearch(
  base: string,
  /** `undefined` surveys the whole account; an array scopes to exactly it. */
  repos: readonly RepoRef[] | undefined,
  budget = 250
): PullSearch {
  if (repos === undefined) {
    return { query: base, allow: undefined, filteredClientSide: false };
  }
  const allow = new Set(repos.map((repo) => repoSlug(repo).toLowerCase()));
  const qualifiers = repos.map((repo) => `repo:${repoSlug(repo)}`);
  const full = [base, ...qualifiers].join(' ');

  if (repos.length > 0 && full.length <= budget) {
    return { query: full, allow, filteredClientSide: false };
  }
  return { query: base, allow, filteredClientSide: repos.length > 0 };
}

/**
 * Drops anything outside the caller's repositories.
 *
 * `undefined` is unscoped and keeps everything; an empty set keeps nothing.
 * See `PullSearch.allow` for why those are different.
 */
export function withinScope<T extends { repo: string }>(
  items: readonly T[],
  allow: ReadonlySet<string> | undefined
): T[] {
  if (allow === undefined) {
    return [...items];
  }
  if (allow.size === 0) {
    return [];
  }
  return items.filter((item) => allow.has(item.repo.toLowerCase()));
}
