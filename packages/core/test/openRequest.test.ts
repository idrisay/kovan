import { describe, expect, it } from 'vitest';
import { diffSideFor, parseOpenRequest } from '../src/openRequest';

describe('parseOpenRequest', () => {
  it('reads a file inside its repository', () => {
    expect(parseOpenRequest(JSON.stringify({ repo: '/r/web', file: '/r/web/src/a.ts' })))
      .toEqual({ repo: '/r/web', file: 'src/a.ts' });
    expect(parseOpenRequest(JSON.stringify({ repo: '/r/web/', file: '/r/web/a.ts' })))
      .toEqual({ repo: '/r/web', file: 'a.ts' });
  });

  it('refuses anything else', () => {
    const bad = [
      'not json',
      'null',
      JSON.stringify({ repo: '/r/web' }),
      JSON.stringify({ repo: 'r/web', file: 'r/web/a.ts' }),
      JSON.stringify({ repo: '/r/web', file: '/r/other/a.ts' }),
      JSON.stringify({ repo: '/r/web', file: '/r/webby/a.ts' }),
      JSON.stringify({ repo: '/r/web', file: '/r/web/../../etc/passwd' }),
      JSON.stringify({ repo: '/r/web', file: '/r/web' }),
      JSON.stringify({ repo: '/', file: '/a.ts' }),
      JSON.stringify({ repo: '/r/web', file: '/r/web/a\nb' })
    ];
    for (const text of bad) expect(parseOpenRequest(text)).toBeUndefined();
  });
});

describe('diffSideFor', () => {
  const status = {
    staged: [{ path: 'both.ts' }, { path: 'staged.ts' }],
    unstaged: [{ path: 'both.ts' }, { path: 'edited.ts' }],
    untracked: [{ path: 'new.ts' }]
  };

  it('picks the diff that shows the change now', () => {
    expect(diffSideFor(status, 'new.ts')).toBe('untracked');
    expect(diffSideFor(status, 'edited.ts')).toBe('unstaged');
    expect(diffSideFor(status, 'both.ts')).toBe('unstaged');
    expect(diffSideFor(status, 'staged.ts')).toBe('staged');
    expect(diffSideFor(status, 'clean.ts')).toBeUndefined();
  });
});
