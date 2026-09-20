/**
 * The read-only file viewer.
 *
 * Read-only is a decision, not a missing feature. Baton's job is to tell you
 * what is blocked on you and hand it to an agent; the agent edits, in a
 * terminal you can watch. An editor here would be a second place where the
 * same file is open, with all the save-conflict handling that implies, for a
 * workflow nobody asked for. Reading the code to decide *what to ask for* is
 * the part this view is actually needed for.
 *
 * It is also why there is no Monaco. Monaco is roughly 5 MB and arrives with
 * its own theme, scrollbars and font stack, all of which would have to be
 * fought back into the design language on every release.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightBlock, languageFor } from './highlight';
import type { FileBody } from './types';

/**
 * Rendered rows are capped.
 *
 * A 40,000-line lockfile is 40,000 DOM nodes and several seconds of layout.
 * The cap keeps the first paint immediate and says plainly that there is more,
 * which is better than a viewer that appears to hang.
 */
const MAX_RENDERED_LINES = 5000;

export function Code({ path, body }: { path: string; body: FileBody }) {
  if (body.kind === 'binary') {
    return <Notice>Binary file · {formatBytes(body.bytes)}</Notice>;
  }
  if (body.kind === 'too-large') {
    return <Notice>Too large to display · {formatBytes(body.bytes)}</Notice>;
  }
  return <TextBody path={path} body={body} />;
}

function TextBody({
  path,
  body
}: {
  path: string;
  body: Extract<FileBody, { kind: 'text' }>;
}) {
  const [shown, setShown] = useState(MAX_RENDERED_LINES);
  const scroller = useRef<HTMLDivElement>(null);

  // A new file starts at the top and back at the cap; without this, opening a
  // short file after a long one keeps the previous scroll offset.
  useEffect(() => {
    setShown(MAX_RENDERED_LINES);
    scroller.current?.scrollTo({ top: 0 });
  }, [path]);

  // A trailing newline ends the last line rather than starting a blank one.
  const source = useMemo(() => body.text.replace(/\n$/, '').split('\n'), [body.text]);
  const total = source.length;

  /**
   * Only the rows that will actually be rendered are highlighted.
   *
   * The slice happens before the highlight, not after: highlighting a 40,000
   * line file to then throw 35,000 of them away is most of the cost of the
   * thing the cap exists to avoid.
   */
  const lines = useMemo(
    () => highlightBlock(source.slice(0, shown).join('\n'), path),
    [source, shown, path]
  );
  const language = languageFor(path);

  return (
    <div className="code" ref={scroller}>
      <table className="code-table">
        <tbody>
          {lines.map((html, index) => (
            <tr key={index}>
              <td className="code-num">{index + 1}</td>
              {/*
                The content is a local file the user chose to open, and the
                highlighter escapes every character it did not itself emit —
                see `escapeHtml` in highlight.ts. This is the one place the
                app renders HTML it built rather than HTML it received.
              */}
              <td className="code-line" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            </tr>
          ))}
        </tbody>
      </table>
      {total > shown && (
        <div className="code-more">
          <span>
            Showing {shown.toLocaleString()} of {total.toLocaleString()} lines
          </span>
          <button className="ghost" onClick={() => setShown(total)}>
            Show all
          </button>
        </div>
      )}
      <div className="code-foot">
        <span>{language ?? 'plain text'}</span>
        <span>{total.toLocaleString()} lines</span>
        <span>{formatBytes(body.bytes)}</span>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="quiet centred">{children}</p>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
