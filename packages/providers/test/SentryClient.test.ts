import { describe, expect, it, vi } from 'vitest';
import { SentryClient } from '../src/sentry/SentryClient';
import type { HttpClient } from '../src/http';

const rawIssue = (project: string) => ({
  id: '1',
  shortId: `${project.toUpperCase()}-1`,
  title: 'TypeError: boom',
  culprit: 'app.render',
  level: 'error',
  count: '3',
  userCount: 2,
  permalink: 'https://acme.sentry.io/issues/1/',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-02T00:00:00.000Z',
  project: { slug: project }
});

/** Just enough of `HttpClient` to capture the URL and hand back canned issues. */
function fakeHttp(issues: unknown[]) {
  const urls: string[] = [];
  const http = {
    json: vi.fn(async (url: string) => { urls.push(url); return issues; })
  } as unknown as HttpClient;
  return { http, urls };
}

describe('SentryClient.listIssues', () => {
  it('scopes to the one project, and carries the project slug through', async () => {
    const { http, urls } = fakeHttp([rawIssue('web-app')]);
    const client = new SentryClient(http, 'https://sentry.io', 'acme', 'token');

    const issues = await client.listIssues('web-app', 'is:unresolved', 25);

    expect(urls[0]).toContain('/api/0/projects/acme/web-app/issues/');
    expect(issues).toEqual([
      {
        id: '1', shortId: 'WEB-APP-1', title: 'TypeError: boom', culprit: 'app.render',
        level: 'error', count: 3, userCount: 2, permalink: 'https://acme.sentry.io/issues/1/',
        project: 'web-app', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z'
      }
    ]);
  });
});

describe('SentryClient.listAllIssues', () => {
  it('hits the organization-wide endpoint, not a single project', async () => {
    const { http, urls } = fakeHttp([rawIssue('web-app'), rawIssue('mobile')]);
    const client = new SentryClient(http, 'https://sentry.io', 'acme', 'token');

    const issues = await client.listAllIssues('is:unresolved', 25);

    expect(urls[0]).toContain('/api/0/organizations/acme/issues/');
    expect(urls[0]).not.toContain('/projects/');
    // Each issue keeps whichever project it actually came from — there is no
    // single fallback to hand out when the request spans every project.
    expect(issues.map((i) => i.project)).toEqual(['web-app', 'mobile']);
  });

  it('falls back to an empty project when Sentry omits it, rather than mislabeling the issue', async () => {
    const bare = { ...rawIssue('web-app'), project: undefined };
    const { http } = fakeHttp([bare]);
    const client = new SentryClient(http, 'https://sentry.io', 'acme', 'token');

    const [issue] = await client.listAllIssues('is:unresolved', 25);
    expect(issue?.project).toBe('');
  });
});
