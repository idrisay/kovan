import { describe, expect, it } from 'vitest';
import { changeCount, parseStatus } from '../src/status';

/** Records are NUL-separated; writing them this way keeps the tests readable. */
const z = (...records: string[]) => records.join('\0') + '\0';

describe('parseStatus', () => {
  it('reads the branch header', () => {
    const status = parseStatus(
      z(
        '# branch.oid 1a2b3c',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +3 -1'
      )
    );
    expect(status.branch).toBe('main');
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(1);
    expect(status.unborn).toBe(false);
  });

  it('treats a detached HEAD as having no branch', () => {
    const status = parseStatus(z('# branch.oid 1a2b3c', '# branch.head (detached)'));
    expect(status.branch).toBeUndefined();
  });

  it('flags a repository with no commits yet', () => {
    const status = parseStatus(z('# branch.oid (initial)', '# branch.head main'));
    expect(status.unborn).toBe(true);
  });

  it('splits a file that is staged and modified again into both sides', () => {
    // XY = "MM": modified in the index AND modified again in the tree.
    const status = parseStatus(z('1 MM N... 100644 100644 100644 aaa bbb src/app.ts'));
    expect(status.staged).toEqual([{ path: 'src/app.ts', side: 'staged', kind: 'modified' }]);
    expect(status.unstaged).toEqual([{ path: 'src/app.ts', side: 'unstaged', kind: 'modified' }]);
    // …but it is one file, so the badge must not say 2.
    expect(changeCount(status)).toBe(1);
  });

  it('puts a staged-only addition on the staged side alone', () => {
    const status = parseStatus(z('1 A. N... 000000 100644 100644 000 bbb new.py'));
    expect(status.staged).toEqual([{ path: 'new.py', side: 'staged', kind: 'added' }]);
    expect(status.unstaged).toEqual([]);
  });

  it('reports a deletion in the working tree', () => {
    const status = parseStatus(z('1 .D N... 100644 100644 000000 aaa aaa gone.ts'));
    expect(status.unstaged).toEqual([{ path: 'gone.ts', side: 'unstaged', kind: 'deleted' }]);
  });

  it('consumes the rename source, which is its own record', () => {
    const status = parseStatus(
      z(
        '2 R. N... 100644 100644 100644 aaa bbb R100 dst/new.ts',
        'src/old.ts',
        '1 M. N... 100644 100644 100644 ccc ddd after.ts'
      )
    );
    expect(status.staged).toEqual([
      { path: 'dst/new.ts', from: 'src/old.ts', side: 'staged', kind: 'renamed' },
      // The record after the rename source must still parse — if the source
      // were not stepped over, this entry would be lost.
      { path: 'after.ts', side: 'staged', kind: 'modified' }
    ]);
  });

  it('keeps spaces in paths, which is why -z exists', () => {
    const status = parseStatus(z('1 .M N... 100644 100644 100644 aaa bbb src/My File (1).ts'));
    expect(status.unstaged[0]?.path).toBe('src/My File (1).ts');
  });

  it('collects untracked files', () => {
    const status = parseStatus(z('? notes.md', '? build/out.js'));
    expect(status.untracked.map((c) => c.path)).toEqual(['notes.md', 'build/out.js']);
    expect(status.untracked.every((c) => c.kind === 'untracked')).toBe(true);
  });

  it('surfaces a conflict as something to resolve', () => {
    const status = parseStatus(
      z('u UU N... 100644 100644 100644 100644 aaa bbb ccc src/merge.ts')
    );
    expect(status.unstaged).toEqual([
      { path: 'src/merge.ts', side: 'unstaged', kind: 'conflicted' }
    ]);
  });

  it('ignores ignored entries and empty records', () => {
    const status = parseStatus(z('! node_modules/', '', '? real.ts'));
    expect(status.untracked.map((c) => c.path)).toEqual(['real.ts']);
  });

  it('returns an empty status for a clean tree', () => {
    const status = parseStatus(z('# branch.oid 1a2b3c', '# branch.head main'));
    expect(changeCount(status)).toBe(0);
  });
});
