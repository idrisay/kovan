import { describe, expect, it } from 'vitest';
import { describeProblem, trackProblems, PROBLEM_LIMIT, type Problem } from '../src/problems';

const TIMEOUT = 'Request to https://sentry.io/api/0/organizations/acme/issues/?query=is%3Aunresolved&limit=25 timed out after 15000ms';

describe('describeProblem', () => {
  it('says a timeout in words, without the address', () => {
    expect(describeProblem('sentry', TIMEOUT)).toEqual({ title: "Sentry didn't answer", detail: 'within 15 s' });
  });

  it('names a rejected token, a rate limit, no network and a server error', () => {
    expect(describeProblem('github', 'HTTP 401 Bad credentials').title).toBe('GitHub rejected the token');
    expect(describeProblem('jira', 'HTTP 429 Too Many Requests').title).toBe('Jira is rate limiting Kovan');
    expect(describeProblem('jira', 'getaddrinfo ENOTFOUND acme.atlassian.net').title).toBe("Jira couldn't be reached");
    expect(describeProblem('sentry', 'HTTP 502 Bad Gateway')).toEqual({ title: 'Sentry had a server error', detail: 'HTTP 502; usually passes' });
  });

  it('keeps anything else, without addresses', () => {
    expect(describeProblem('jira', 'Field x is invalid at https://a.b/c')).toEqual({ title: 'Jira failed', detail: 'Field x is invalid at' });
  });
});

describe('trackProblems', () => {
  it('opens a problem, counts each failing refresh once, and clears it when the service answers', () => {
    const one = trackProblems([], [{ provider: 'sentry', message: TIMEOUT }], ['github', 'jira'], 1000);
    expect(one.started).toHaveLength(1);
    expect(one.log[0]).toMatchObject({ provider: 'sentry', count: 1, startedAt: 1000 });

    // The same refresh published twice is one failure.
    const same = trackProblems(one.log, [{ provider: 'sentry', message: TIMEOUT }], [], 1000);
    expect(same.log[0]!.count).toBe(1);
    const two = trackProblems(same.log, [{ provider: 'sentry', message: TIMEOUT }], [], 61_000);
    expect(two.started).toHaveLength(0);
    expect(two.log[0]).toMatchObject({ count: 2, lastAt: 61_000 });

    const cleared = trackProblems(two.log, [], ['sentry'], 121_000);
    expect(cleared.log[0]!.clearedAt).toBe(121_000);
  });

  it('starts a new problem when the same service fails differently', () => {
    const one = trackProblems([], [{ provider: 'jira', message: 'HTTP 429' }], [], 1000);
    const two = trackProblems(one.log, [{ provider: 'jira', message: 'HTTP 401' }], [], 2000);
    expect(two.started.map((p) => p.title)).toEqual(['Jira rejected the token']);
    expect(two.log.map((p) => [p.title, p.clearedAt])).toEqual([
      ['Jira rejected the token', undefined],
      ['Jira is rate limiting Kovan', 2000]
    ]);
  });

  it('keeps the newest problems only', () => {
    let log: Problem[] = [];
    for (let i = 0; i < PROBLEM_LIMIT + 5; i++) {
      log = trackProblems(log, [{ provider: 'jira', message: `HTTP 50${i % 2}` }], [], i + 1).log;
      log = trackProblems(log, [], ['jira'], i + 1.5).log;
    }
    expect(log).toHaveLength(PROBLEM_LIMIT);
    expect(log[0]!.startedAt).toBe(PROBLEM_LIMIT + 5);
  });
});
