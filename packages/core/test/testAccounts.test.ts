import { describe, expect, it } from 'vitest';
import {
  DEFAULTVERIFYTEMPLATE, accountEnvVars, describeAccount, renderVerifyPrompt, testingClause,
  type TestAccount, type TestEnvironment
} from '../src/index';

const pull = {
  number: 300, title: 'Ship the persistent table scrollbar',
  url: 'https://github.com/acme/api/pull/300', repo: 'acme/api', author: 'idrisay',
  isDraft: false, createdAt: '', updatedAt: '', mergeable: 'mergeable' as const,
  reviewDecision: 'approved' as const, checks: 'success' as const,
  unresolvedThreads: 0, additions: 1, deletions: 0, viewerReviewed: false
};

const account = (id: string, patch: Partial<TestAccount>): TestAccount => ({
  id, environmentId: 'dev', label: '', role: '', segment: '', username: `${id}@example.invalid`, notes: '', ...patch
});

const student = account('s', { label: 'Student', role: 'student', segment: 'b2c' });
const teacher = account('t', { label: 'Teacher with two classes', role: 'teacher', segment: 'b2b', notes: 'owns class 7B' });

describe('test accounts', () => {
  it('describes an account by who it is', () => {
    expect(describeAccount(student)).toBe('Student · B2C');
    expect(describeAccount(teacher)).toBe('Teacher with two classes (teacher) · B2B');
    expect(describeAccount(account('x', {}))).toBe('Account');
  });

  it('numbers credentials in prompt order and keeps the old names for the first', () => {
    const vars = accountEnvVars([student, teacher], { s: 'pw-s', t: 'pw-t' });
    expect(vars).toEqual({
      KOVAN_ACCOUNT_1_USER: 's@example.invalid', KOVAN_ACCOUNT_1_PASSWORD: 'pw-s',
      KOVAN_ACCOUNT_2_USER: 't@example.invalid', KOVAN_ACCOUNT_2_PASSWORD: 'pw-t',
      KOVAN_ENV_USER: 's@example.invalid', KOVAN_ENV_PASSWORD: 'pw-s'
    });
  });

  it('lists every account in the verify prompt, by variable, never by value', () => {
    const out = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, {
      name: 'Local', site: 'http://localhost:3000', accounts: [student, teacher]
    });
    expect(out).not.toMatch(/\$\{\w+\}/);
    expect(out).toContain('actually live on Local');
    expect(out).toContain('1. Student · B2C: username in $KOVAN_ACCOUNT_1_USER');
    expect(out).toContain('2. Teacher with two classes (teacher) · B2B — owns class 7B');
    expect(out).not.toContain('@example.invalid');
    expect(out).not.toContain('$KOVAN_ENV_USER');
  });

  it('tells the agent to stop rather than sign up when there is no account', () => {
    const out = renderVerifyPrompt(DEFAULTVERIFYTEMPLATE, pull, { name: 'Dev', site: 'https://dev.invalid', accounts: [] });
    expect(out).toContain('No test account is set up for Dev');
  });

  it('still names the accounts for a template saved before they existed', () => {
    const old = 'Check ${title} on ${env} at ${site}. Sign in with $KOVAN_ENV_USER.';
    const out = renderVerifyPrompt(old, pull, { name: 'Dev', site: 'https://dev.invalid', accounts: [student, teacher] });
    expect(out).toContain('$KOVAN_ENV_USER');
    expect(out).toContain('$KOVAN_ACCOUNT_2_USER');
  });

  it('adds a where-to-test section to implement prompts', () => {
    const env: TestEnvironment = { id: 'local', name: 'Local', site: 'http://localhost:3000', basicAuth: true, basicUsername: 'u' };
    const out = testingClause(env, [teacher]);
    expect(out).toContain('use Local at http://localhost:3000');
    expect(out).toContain('$KOVAN_ACCOUNT_1_PASSWORD');
    expect(out).toContain('$KOVAN_ENV_BASIC_USER');
    expect(out).not.toContain('t@example.invalid');
  });
});
