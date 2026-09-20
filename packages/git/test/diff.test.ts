import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff';

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 return a;
 }
`;

describe('parseDiff', () => {
  it('counts additions and deletions', () => {
    const diff = parseDiff(DIFF);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.binary).toBe(false);
    expect(diff.empty).toBe(false);
  });

  it('numbers both sides from the hunk header', () => {
    const [hunk] = parseDiff(DIFF).hunks;
    expect(hunk?.lines).toEqual([
      { kind: 'context', text: 'const a = 1;', old: 10, new: 10 },
      { kind: 'del', text: 'const b = 2;', old: 11 },
      { kind: 'add', text: 'const b = 3;', new: 11 },
      { kind: 'add', text: 'const c = 4;', new: 12 },
      // The counters must diverge: one line was removed and two added, so the
      // new side is now one ahead of the old.
      { kind: 'context', text: 'const d = 5;', old: 12, new: 13 },
      { kind: 'context', text: 'return a;', old: 13, new: 14 },
      { kind: 'context', text: '}', old: 14, new: 15 }
    ]);
  });

  it('keeps the section heading on the hunk header', () => {
    expect(parseDiff(DIFF).hunks[0]?.header).toBe('@@ -10,7 +10,8 @@ export function main() {');
  });

  it('handles a single-line hunk, where the count is omitted', () => {
    const diff = parseDiff('@@ -1 +1 @@\n-old\n+new\n');
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'old', old: 1 },
      { kind: 'add', text: 'new', new: 1 }
    ]);
  });

  it('reads several hunks', () => {
    const diff = parseDiff('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-c\n+d\n');
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[1]?.lines[0]).toEqual({ kind: 'del', text: 'c', old: 50 });
  });

  it('preserves a blank context line rather than dropping it', () => {
    const diff = parseDiff('@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n');
    expect(diff.hunks[0]?.lines[1]).toEqual({ kind: 'context', text: '', old: 2, new: 2 });
  });

  it('keeps the no-newline marker, which is a real difference', () => {
    const diff = parseDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n');
    expect(diff.hunks[0]?.lines[1]).toEqual({ kind: 'meta', text: 'No newline at end of file' });
  });

  it('flags a binary file instead of inventing hunks', () => {
    const diff = parseDiff('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n');
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it('ignores the preamble, which carries nothing the view needs', () => {
    expect(parseDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n').hunks).toEqual([]);
  });

  it('reports no change as empty rather than as a diff of nothing', () => {
    expect(parseDiff('').empty).toBe(true);
  });
});
