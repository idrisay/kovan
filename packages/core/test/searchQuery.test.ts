import { describe, expect, it } from 'vitest';
import { buildPullSearch, withinScope } from '../src/github/searchQuery';
import type { RepoRef } from '../src/github/remoteUrl';

const repo = (owner: string, name: string): RepoRef => ({ owner, name });
const pull = (r: string) => ({ repo: r });

describe('scope: undefined vs empty', () => {
  it('undefined surveys the whole account', () => {
    const search = buildPullSearch('is:pr is:open author:@me', undefined);
    expect(search.query).toBe('is:pr is:open author:@me');
    expect(search.allow).toBeUndefined();
    expect(search.filteredClientSide).toBe(false);
    expect(withinScope([pull('acme/web'), pull('other/api')], search.allow)).toHaveLength(2);
  });

  it('an empty array is scoped to nothing, and keeps nothing', () => {
    const search = buildPullSearch('is:pr is:open author:@me', []);
    expect(search.allow?.size).toBe(0);
    expect(withinScope([pull('acme/web')], search.allow)).toHaveLength(0);
  });

  it('an explicit list keeps only those repositories', () => {
    const search = buildPullSearch('is:pr is:open author:@me', [repo('acme', 'web')]);
    expect(search.query).toContain('repo:acme/web');
    expect(withinScope([pull('acme/web'), pull('other/api')], search.allow)).toHaveLength(1);
  });

  it('matches repository names case-insensitively', () => {
    const search = buildPullSearch('x', [repo('Acme', 'Web')]);
    expect(withinScope([pull('acme/web')], search.allow)).toHaveLength(1);
  });
});

describe('the 256-character query limit', () => {
  it('falls back to response-side filtering when the qualifiers do not fit', () => {
    const many = Array.from({ length: 12 }, (_, i) => repo('some-organisation', `repository-${i}`));
    const search = buildPullSearch('is:pr is:open author:@me', many);
    expect(search.query).toBe('is:pr is:open author:@me');
    expect(search.filteredClientSide).toBe(true);
    // Correctness must not depend on the query string.
    expect(withinScope([pull('some-organisation/repository-3'), pull('x/y')], search.allow))
      .toHaveLength(1);
  });
});
