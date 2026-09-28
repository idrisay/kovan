import { describe, expect, it } from 'vitest';
import { changeMarks, type MarkLine } from '../src/changeMarks';

const ctx = (n: number): MarkLine => ({ kind: 'context', new: n });
const add = (n: number): MarkLine => ({ kind: 'add', new: n });
const del: MarkLine = { kind: 'del' };

describe('changeMarks', () => {
  it('marks new lines as added', () => {
    expect(changeMarks([{ lines: [ctx(1), add(2), add(3), ctx(4)] }])).toEqual([
      { line: 2, kind: 'added' }, { line: 3, kind: 'added' }
    ]);
  });

  it('marks a replaced line as modified, not added', () => {
    expect(changeMarks([{ lines: [ctx(4), del, add(5), ctx(6)] }])).toEqual([
      { line: 5, kind: 'modified' }
    ]);
  });

  it('marks the line after a removal', () => {
    expect(changeMarks([{ lines: [ctx(7), del, del, ctx(8)] }])).toEqual([
      { line: 8, kind: 'deleted' }
    ]);
  });

  it('handles a removal at the very top and the very end', () => {
    expect(changeMarks([{ lines: [del, ctx(1)] }])).toEqual([{ line: 1, kind: 'deleted' }]);
    expect(changeMarks([{ lines: [ctx(9), ctx(10), del] }])).toEqual([{ line: 11, kind: 'deleted' }]);
  });

  it('keeps separate edits in one hunk apart', () => {
    expect(changeMarks([{ lines: [ctx(1), add(2), del, ctx(3), del, add(4)] }])).toEqual([
      { line: 2, kind: 'added' },
      { line: 3, kind: 'deleted' },
      { line: 4, kind: 'modified' }
    ]);
  });

  it('ignores meta lines and reads several hunks', () => {
    expect(changeMarks([
      { lines: [ctx(1), add(2)] },
      { lines: [ctx(40), del, add(41), { kind: 'meta' }] }
    ])).toEqual([{ line: 2, kind: 'added' }, { line: 41, kind: 'modified' }]);
  });
});
