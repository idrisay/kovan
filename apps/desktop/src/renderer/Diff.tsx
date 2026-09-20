/**
 * The diff viewer.
 *
 * Unified rather than side-by-side. Side-by-side is what VS Code opens by
 * default, but it assumes a full editor width: here the diff shares the window
 * with a rail and an explorer, leaving each column around 300px — narrow
 * enough that real code wraps, and a wrapped side-by-side diff stops lining up,
 * which is the only thing side-by-side is for. Unified keeps full width for
 * the code and still shows both line numbers.
 *
 * Each line is syntax-highlighted with the file's own grammar, so a diff of a
 * `.py` reads as Python and not as undifferentiated grey.
 */

import { useMemo } from 'react';
import { highlightBlock } from './highlight';
import type { DiffSide, FileDiff } from './types';

const SIDE_LABEL: Record<DiffSide, string> = {
  staged: 'Staged',
  unstaged: 'Working tree',
  untracked: 'New file'
};

export function Diff({
  path,
  side,
  from,
  diff
}: {
  path: string;
  side: DiffSide;
  from?: string;
  diff: FileDiff;
}) {
  /**
   * Highlighting runs per hunk, not per file.
   *
   * A hunk begins at an arbitrary line, so the grammar's state at that point
   * is unknown — carrying a continuation across the gap between hunks would
   * confidently mis-highlight everything after the first one. Restarting at
   * each hunk is occasionally wrong at the hunk's first line and right
   * everywhere else.
   */
  const rendered = useMemo(
    () =>
      diff.hunks.map((hunk) => {
        // Both sides of the hunk are highlighted as one block so a multi-line
        // string or comment inside it stays coloured. The `-` and `+` markers
        // are stripped by the parser already, so what is highlighted is the
        // code itself — near enough to valid source for the grammar to follow.
        const code = hunk.lines.map((line) => line.text);
        const html = highlightBlock(code.join('\n'), path);
        return {
          header: hunk.header,
          lines: hunk.lines.map((line, i) => ({
            ...line,
            html: line.kind === 'meta' ? line.text : html[i] ?? ''
          }))
        };
      }),
    [diff, path]
  );

  if (diff.binary) {
    return <p className="quiet centred">Binary file — no textual diff.</p>;
  }
  if (diff.empty) {
    return <p className="quiet centred">No changes in this file.</p>;
  }

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-side">{SIDE_LABEL[side]}</span>
        {from && from !== path && (
          <span className="diff-rename">
            renamed from <span className="mono">{from}</span>
          </span>
        )}
        <span className="spacer" />
        <span className="adds">+{diff.additions}</span>
        <span className="dels">−{diff.deletions}</span>
      </div>

      {rendered.map((hunk, h) => (
        <div className="hunk" key={h}>
          <div className="hunk-head">{hunk.header}</div>
          <table className="code-table">
            <tbody>
              {hunk.lines.map((line, i) =>
                line.kind === 'meta' ? (
                  <tr key={i} className="diff-meta">
                    <td className="code-num" />
                    <td className="code-num" />
                    <td className="code-line">{line.text}</td>
                  </tr>
                ) : (
                  <tr key={i} className={`diff-${line.kind}`}>
                    <td className="code-num">{line.old ?? ''}</td>
                    <td className="code-num">{line.new ?? ''}</td>
                    <td className="code-line">
                      {/* A dedicated column would cost width on every row; the
                          marker rides in the gutter of the code cell instead. */}
                      <span className="diff-mark" aria-hidden="true">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                      </span>
                      {/* Built here by the highlighter, which escapes everything
                          it did not emit. See highlight.ts. */}
                      <span dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
