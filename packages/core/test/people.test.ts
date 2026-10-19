import { describe, expect, it } from 'vitest';
import { DEFAULT_TASKS_JQL, isGitHubLogin, personJql, projectKeys, rankTeammates } from '../src/people';

describe('rankTeammates', () => {
  it('counts open items per person, most first, and keeps people with none', () => {
    const ranked = rankTeammates([
      { id: 'lena-b', name: 'Lena Brandt', handle: 'lena-b', open: true },
      { id: 'dave-dev', name: '', handle: 'dave-dev', open: true },
      { id: 'lena-b', name: 'Lena Brandt', handle: 'lena-b', open: true },
      { id: 'jonas-h', name: 'Jonas Huber', handle: 'jonas-h', open: false },
      { id: 'dave-dev', name: '', handle: 'dave-dev', open: false }
    ], []);
    expect(ranked).toEqual([
      { id: 'lena-b', name: 'Lena Brandt', handle: 'lena-b', open: 2 },
      { id: 'dave-dev', name: 'dave-dev', handle: 'dave-dev', open: 1 },
      { id: 'jonas-h', name: 'Jonas Huber', handle: 'jonas-h', open: 0 }
    ]);
  });

  it('leaves you out, whatever the case', () => {
    expect(rankTeammates([{ id: 'IdrisAy', name: 'Idris', open: true }, { id: 'ana-r', name: 'Ana', open: true }], ['idrisay', ''])
      .map((t) => t.id)).toEqual(['ana-r']);
  });

  it('breaks ties by name', () => {
    expect(rankTeammates([{ id: 'b', name: 'Zoe', open: false }, { id: 'a', name: 'Ada', open: false }], []).map((t) => t.name))
      .toEqual(['Ada', 'Zoe']);
  });
});

describe('isGitHubLogin', () => {
  it('accepts logins and refuses anything that would change a search', () => {
    expect(isGitHubLogin('lena-b')).toBe(true);
    expect(isGitHubLogin('a')).toBe(true);
    expect(isGitHubLogin('-lead')).toBe(false);
    expect(isGitHubLogin('a b')).toBe(false);
    expect(isGitHubLogin('x is:merged')).toBe(false);
    expect(isGitHubLogin('dependabot[bot]')).toBe(false);
    expect(isGitHubLogin('')).toBe(false);
  });
});

describe('personJql', () => {
  it('asks your query about them', () => {
    expect(personJql('assignee = currentUser() AND project = ACME ORDER BY priority', '712020:abc'))
      .toBe('assignee = "712020:abc" AND project = ACME ORDER BY priority');
  });

  it('replaces every currentUser(), however spelled', () => {
    expect(personJql('assignee = currentuser( ) OR reporter = currentUser()', 'x'))
      .toBe('assignee = "x" OR reporter = "x"');
  });

  it('falls back to the default when your query never names you', () => {
    expect(personJql('project = ACME', 'x')).toBe(DEFAULT_TASKS_JQL.replace('currentUser()', '"x"'));
  });

  it('cannot be broken out of by the id', () => {
    expect(personJql(DEFAULT_TASKS_JQL, 'x" OR project = SECRET OR assignee = "y')).toContain('"x OR project = SECRET OR assignee = y"');
  });
});

describe('projectKeys', () => {
  it('reads each project once', () => {
    expect(projectKeys([{ key: 'ACME-1' }, { key: 'ACME-22' }, { key: 'OPS-3' }, { key: 'bad' }])).toEqual(['ACME', 'OPS']);
  });
});
