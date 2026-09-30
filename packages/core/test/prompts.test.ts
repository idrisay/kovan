import { describe, expect, it } from 'vitest';
import {
  DEFAULTUPDATETEMPLATE,
  renderPullPrompt,
  substitute,
  ticketKeyInTitle,
  DEFAULTVERIFYTEMPLATE,
  renderVerifyPrompt,
  VERDICTS
} from '../src/prompts';
import type { PullSummary } from '../src/github/pullStatus';

const pull: PullSummary = {
  number: 42,
  title: 'ACME-2469 Fix the retry',
  url: 'https://example.invalid/pr/42',
  repo: 'acme/web',
  author: 'someone',
  isDraft: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mergeable: 'conflicting',
  reviewDecision: 'changes_requested',
  checks: 'failure',
  unresolvedThreads: 2,
  additions: 1,
  deletions: 1,
  viewerReviewed: false
};

describe('malformed conventions', () => {
  // These shapes are what an import from the Swift app produced before the
  // Data blobs were decoded, and each one crashed the prompt builder.
  it('survives conventions with missing arrays', () => {
    expect(() =>
      renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: {} as never })
    ).not.toThrow();
  });

  it('survives conventions that are not an object at all', () => {
    expect(() =>
      renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: 'nonsense' as never })
    ).not.toThrow();
  });

  it('falls back to the default base branch when none is given', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: {} as never });
    expect(out).not.toContain('${base}');
  });

  it('uses real conventions when they are well formed', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, {
      conventions: {
        baseBranch: 'develop',
        checks: ['npm run type-check', 'npm run eslint'],
        untouchable: [],
        pullRequestReviewers: []
      }
    });
    expect(out).toContain('npm run type-check');
  });
});

describe('substitution', () => {
  it('leaves an unknown placeholder visible rather than blanking it', () => {
    // A typo somebody can see and fix beats one silently swallowed.
    expect(substitute('a ${nope} b', { x: '1' })).toBe('a ${nope} b');
  });

  it('renders the state in the pull request prompt', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull);
    expect(out).toContain('Conflicts');
    expect(out).toContain('Changes requested');
  });

  it('carries the Kovan env contract, not DevHub\'s', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull);
    expect(out).toContain('KOVAN_REPORT');
    expect(out).not.toContain('DEVHUB_');
  });
});

describe('ticket keys', () => {
  it('finds the key in a pull request title', () => {
    expect(ticketKeyInTitle('ACME-2469 Fix the retry')).toBe('ACME-2469');
    expect(ticketKeyInTitle('no key here')).toBe('');
  });
});

describe('the verify prompt', () => {
  const pull = {
    number: 300, title: 'Ship the persistent table scrollbar',
    url: 'https://github.com/acme/api/pull/300', repo: 'acme/api', author: 'idrisay',
    isDraft: false, createdAt: '', updatedAt: '', mergeable: 'mergeable' as const,
    reviewDecision: 'approved' as const, checks: 'success' as const,
    unresolvedThreads: 0, additions: 1, deletions: 0, viewerReviewed: false,
    mergedAt: '2026-09-19T09:00:00Z'
  };
  const env = { name: 'Dev', site: 'https://dev.example.invalid' };

  it('leaves no placeholder behind', () => {
    const out = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, env);
    // The bug this renderer exists for: substitute() leaves an unknown
    // ${name} alone, so the general path shipped four of them to the agent.
    expect(out).not.toMatch(/\$\{\w+\}/);
    expect(out).toContain('actually live on Dev');
    expect(out).toContain('The site is https://dev.example.invalid');
  });

  it('offers exactly the verdicts the list defines', () => {
    const out = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, env);
    for (const verdict of VERDICTS) {
      expect(out).toContain(`VERDICT: ${verdict}`);
    }
  });

  it('says so rather than inventing a site when none is configured', () => {
    const out = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, { name: '', site: '' });
    expect(out).not.toMatch(/\$\{\w+\}/);
    expect(out).toContain('NOT CONFIGURED');
    expect(out).toContain('could not check');
  });

  it('mentions the basic-auth wall only where there is one', () => {
    const without = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, env);
    const withWall = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, { ...env, hasBasicAuth: true });
    expect(without).not.toContain('KOVAN_ENV_BASIC_USER');
    expect(withWall).toContain('KOVAN_ENV_BASIC_USER');
  });
});
