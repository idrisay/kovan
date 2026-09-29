import { describe, expect, it } from 'vitest';
import { matchPath, parseQuickQuery, pushRecent, rankPaths } from '../src';

describe('quick open (item 100)', () => {
  it('reads a line number after a colon', () => {
    expect(parseQuickQuery('poller.ts:42')).toEqual({ text: 'poller.ts', line: 42 });
    expect(parseQuickQuery('poller.ts:')).toEqual({ text: 'poller.ts' });
    expect(parseQuickQuery('  app ')).toEqual({ text: 'app' });
  });

  it('matches characters in order, and not otherwise', () => {
    expect(matchPath('plts', 'src/main/poller.ts')).toBeDefined();
    expect(matchPath('xyz', 'src/main/poller.ts')).toBeUndefined();
    expect(matchPath('', 'anything')?.score).toBe(0);
  });

  it('puts a file-name match above a scattered folder match', () => {
    const files = ['apps/desktop/src/renderer/Workspace.tsx', 'apps/desktop/src/main/workspace.ts', 'packages/core/src/work/repoWork.ts', 'notes/workshop.md'];
    const ranked = rankPaths('workspace', files, (f) => f).map((r) => r.item);
    expect(ranked.slice(0, 2).sort()).toEqual(['apps/desktop/src/main/workspace.ts', 'apps/desktop/src/renderer/Workspace.tsx']);
    expect(ranked).not.toContain('notes/workshop.md');
  });

  it('prefers a whole name match over scattered letters', () => {
    const ranked = rankPaths('smts', ['src/main/smoke.ts', 'src/main/sessions.ts', 'some/much/tests.snap'], (f) => f);
    expect(ranked[0]!.item).toBe('src/main/smoke.ts');
  });

  it('keeps the recent list unique, newest first, bounded', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
});
