/**
 * The editor's change bars: which lines of the working file are new, changed,
 * or sit where something was removed — VS Code's "quick diff" gutter.
 *
 * Structural types rather than `@kovan/git`'s, so this stays in the barrel the
 * renderer loads without pulling git's node imports in.
 */

export interface MarkLine {
  kind: 'context' | 'add' | 'del' | 'meta';
  /** 1-based line on the new side; absent for a removed line. */
  new?: number;
}

export type ChangeMarkKind = 'added' | 'modified' | 'deleted';

export interface ChangeMark {
  /** 1-based line in the working file. A deletion marks the line after the gap. */
  line: number;
  kind: ChangeMarkKind;
}

/**
 * One mark per affected line, from a diff's hunks.
 *
 * A run of removed lines followed by added ones is one edit, so its added
 * lines are "modified", not "added" — otherwise changing a line would show as
 * a brand-new one. Removed lines with nothing added mark the line that now
 * sits where they were, as VS Code's small triangle does.
 */
export function changeMarks(hunks: readonly { lines: readonly MarkLine[] }[]): ChangeMark[] {
  const marks: ChangeMark[] = [];
  for (const hunk of hunks) {
    let dels = 0;
    let adds: number[] = [];
    // The new-side line just before the current run, so a pure deletion
    // knows where the gap is even when the hunk ends with it.
    let before = 0;
    let last = 0;
    const flush = () => {
      if (adds.length > 0) {
        const kind: ChangeMarkKind = dels > 0 ? 'modified' : 'added';
        for (const line of adds) marks.push({ line, kind });
      } else if (dels > 0) {
        marks.push({ line: Math.max(1, before + 1), kind: 'deleted' });
      }
      dels = 0;
      adds = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === 'meta') continue;
      if (line.kind === 'context') {
        flush();
        if (line.new !== undefined) last = line.new;
        before = last;
        continue;
      }
      if (line.kind === 'del') {
        // A removal after additions starts a new edit.
        if (adds.length > 0) { flush(); before = last; }
        dels++;
      } else if (line.new !== undefined) {
        adds.push(line.new);
        last = line.new;
      }
    }
    flush();
  }
  return marks;
}
