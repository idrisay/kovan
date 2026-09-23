/**
 * Requesting reviewers on a pull request — the picker under a PR's Reviewers
 * list. GitHub notifies the people itself, the same as requesting on the web.
 */

import type { HttpClient } from '../http';

export interface ReviewerCandidates {
  people: string[];
  /** Team slugs, requestable as `team_reviewers`. */
  teams: { slug: string; name: string }[];
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

/**
 * Who can be asked on this repository: its collaborators and its teams. Each
 * list needs its own permission (collaborators needs push access, teams an
 * organization repo), so a refusal of one leaves the other.
 */
export async function fetchReviewerCandidates(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string
): Promise<ReviewerCandidates> {
  const base = `${baseUrl.replace(/\/$/, '')}/repos/${repo}`;
  const [people, teams] = await Promise.all([
    http
      .json<{ login: string }[]>(`${base}/collaborators?per_page=100&affiliation=all`, { headers: headers(token) })
      .then((list) => (list ?? []).map((u) => u.login))
      .catch(() => [] as string[]),
    http
      .json<{ slug: string; name: string }[]>(`${base}/teams?per_page=100`, { headers: headers(token) })
      .then((list) => (list ?? []).map((t) => ({ slug: t.slug, name: t.name })))
      .catch(() => [] as { slug: string; name: string }[])
  ]);
  return { people, teams };
}

/** Asks people and teams to review. Only from a click; `mutating` so it is never replayed. */
export async function requestPullReviewers(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string,
  number: number,
  reviewers: string[],
  teams: string[]
): Promise<void> {
  await http.json(`${baseUrl.replace(/\/$/, '')}/repos/${repo}/pulls/${number}/requested_reviewers`, {
    method: 'POST',
    mutating: true,
    headers: headers(token),
    body: { reviewers, team_reviewers: teams }
  });
}
