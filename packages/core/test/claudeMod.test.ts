import { describe, expect, it } from 'vitest';
import { modArgs, modEnv, modGoal, promptReviewers } from '../src/claudeMod';

describe('modGoal', () => {
  it('prefers the ticket, then the pull request, then the Sentry issue', () => {
    const pull = { repo: 'acme/acme-backend', number: 861, title: 'Fix lesson sync' };
    const issue = { key: 'ACME-2453', summary: 'Player controls jump on scroll' };
    const sentry = { issue: { shortId: 'WEB-1A2', title: 'TypeError: total' } };
    expect(modGoal({ pull, issue })).toEqual({ goal: 'Player controls jump on scroll', key: 'ACME-2453' });
    expect(modGoal({ pull })).toEqual({ goal: 'Fix lesson sync', key: 'acme-backend#861' });
    expect(modGoal({ sentry })).toEqual({ goal: 'TypeError: total', key: 'WEB-1A2' });
    expect(modGoal({})).toBeUndefined();
  });
});

describe('modEnv', () => {
  it('flattens the goal to one short line', () => {
    expect(modEnv({ goal: 'Two\nlines   here', key: 'X-1' })).toEqual({ KOVAN_GOAL: 'Two lines here', KOVAN_GOAL_KEY: 'X-1' });
    expect(modEnv({ goal: 'a'.repeat(300), key: 'X-1' })['KOVAN_GOAL']).toHaveLength(200);
    expect(modEnv(undefined)).toEqual({});
  });
});

describe('modArgs', () => {
  it('loads the mod into Claude only', () => {
    expect(modArgs('claude', '/mod')).toEqual(['--plugin-dir', '/mod']);
    expect(modArgs('claude-personal', '/mod')).toEqual(['--plugin-dir', '/mod']);
    expect(modArgs('codex', '/mod')).toEqual([]);
    expect(modArgs('claude', undefined)).toEqual([]);
  });
});

describe('promptReviewers (item 167)', () => {
  const prompt = 'Then have or-review, cc-review and nv-review review the result, and fold in what they find.';
  it('keeps the configured reviewers the prompt names, in their order', () => {
    expect(promptReviewers(['nv-review', 'opencode', 'or-review'], prompt)).toEqual(['nv-review', 'or-review']);
  });
  it('matches whole names only', () => {
    expect(promptReviewers(['review', 'cc-orca'], prompt)).toEqual(['review']);
    expect(promptReviewers(['nv'], prompt)).toEqual([]);
  });
  it('reads a name with a note after it by its program', () => {
    expect(promptReviewers(['nv-review (kimi)'], prompt)).toEqual(['nv-review (kimi)']);
  });
  it('is empty without reviewers', () => {
    expect(promptReviewers([], prompt)).toEqual([]);
  });
});
