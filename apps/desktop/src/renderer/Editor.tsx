/**
 * The file editor.
 *
 * CodeMirror 6 rather than Monaco: Monaco is roughly 5 MB and arrives with its
 * own theme, scrollbars and font stack, all of which would have to be fought
 * back into this design on every release. CodeMirror is an order of magnitude
 * smaller, is built to be themed, and still gives real editing — multi-cursor,
 * undo, bracket matching, search.
 *
 * Colours come from `classHighlighter`'s `tok-*` classes, styled in styles.css
 * beside the rest of the design language, rather than from a CodeMirror theme
 * object that nobody would think to look in.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection
} from '@codemirror/view';
import {
  bracketMatching, foldGutter, indentOnInput, syntaxHighlighting
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';
import { languageExtension, languageFor } from './languages';
import type { FileBody, FileStamp } from './types';

export interface EditorHandle {
  dirty: boolean;
  save: () => void;
}

/**
 * Layout only. Everything with a colour is a CSS custom property so the light
 * theme inverts with the rest of the app instead of needing a second theme.
 */
const look = EditorView.theme({
  '&': { height: '100%', fontSize: '11.5px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.7',
    overflow: 'auto'
  },
  '.cm-content': { caretColor: 'var(--clay)', paddingBottom: '40vh' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--dim)',
    fontSize: '10.5px'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--meta)' },
  '.cm-activeLine': { backgroundColor: 'var(--wash)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--clay)', borderLeftWidth: '1.5px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(124, 160, 212, 0.22)'
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(217, 119, 87, 0.16)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(217, 119, 87, 0.22)',
    outline: 'none'
  },
  '.cm-panels': {
    backgroundColor: 'var(--card)',
    color: 'var(--body)',
    borderTop: '1px solid var(--hair)'
  },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'var(--sans)',
    background: 'var(--wash)',
    border: '1px solid var(--hair)',
    borderRadius: '6px',
    color: 'var(--body)'
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(208, 160, 90, 0.25)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(217, 119, 87, 0.4)' }
});

export function Editor({
  path,
  body,
  onDirtyChange,
  onCursor,
  registerSave,
  onSaved
}: {
  path: string;
  body: FileBody;
  onDirtyChange: (dirty: boolean) => void;
  onCursor: (position: { line: number; column: number; selected: number }) => void;
  registerSave: (save: (() => void) | undefined) => void;
  onSaved: (stamp: FileStamp) => void;
}) {
  if (body.kind === 'binary') {
    return <p className="quiet centred">Binary file · {formatBytes(body.bytes)}</p>;
  }
  if (body.kind === 'too-large') {
    return (
      <p className="quiet centred">
        {formatBytes(body.bytes)} is too large to open here — past 2 MB the editor
        would block the window rather than open it.
      </p>
    );
  }
  return (
    <CodeEditor
      path={path}
      body={body}
      onDirtyChange={onDirtyChange}
      onCursor={onCursor}
      registerSave={registerSave}
      onSaved={onSaved}
    />
  );
}

function CodeEditor({
  path,
  body,
  onDirtyChange,
  onCursor,
  registerSave,
  onSaved
}: {
  path: string;
  body: Extract<FileBody, { kind: 'text' }>;
  onDirtyChange: (dirty: boolean) => void;
  onCursor: (position: { line: number; column: number; selected: number }) => void;
  registerSave: (save: (() => void) | undefined) => void;
  onSaved: (stamp: FileStamp) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();

  // Refs, not state: the CodeMirror extensions below are built once, and a
  // keymap closing over a stale `useState` value would save the wrong text.
  const saved = useRef(body.text);
  const stamp = useRef<FileStamp>({ mtimeMs: body.mtimeMs, bytes: body.bytes });
  const [conflict, setConflict] = useState<FileStamp>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!host.current) return undefined;

    const save = async (force = false) => {
      const current = view.current;
      if (!current) return;
      const text = current.state.doc.toString();
      const result = await window.baton.workspaceWrite(
        path,
        text,
        force ? undefined : stamp.current
      );
      if (result.ok) {
        saved.current = text;
        stamp.current = result.stamp;
        setConflict(undefined);
        setError(undefined);
        onDirtyChange(false);
        // The file just changed size; without this the status bar keeps
        // reporting the length it had when it was opened.
        onSaved(result.stamp);
      } else if (result.reason === 'stale') {
        setConflict(result.stamp);
      } else {
        setError(result.message);
      }
    };

    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          void save();
          // Returning true stops the browser's own Save dialog.
          return true;
        }
      }
    ]);

    const report = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDirtyChange(update.state.doc.toString() !== saved.current);
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main;
        const line = update.state.doc.lineAt(head.head);
        onCursor({
          line: line.number,
          column: head.head - line.from + 1,
          selected: Math.abs(head.to - head.from)
        });
      }
    });

    const language = languageExtension(path);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      highlightSelectionMatches(),
      search({ top: false }),
      syntaxHighlighting(classHighlighter),
      EditorView.lineWrapping,
      look,
      saveKey,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      report,
      ...(language ? [language] : [])
    ];

    const instance = new EditorView({
      state: EditorState.create({ doc: body.text, extensions }),
      parent: host.current
    });
    view.current = instance;
    registerSave(() => void save());

    return () => {
      registerSave(undefined);
      instance.destroy();
      view.current = undefined;
    };
    // Rebuilt only when the file changes. `body.text` is deliberately absent:
    // re-running on every keystroke would throw away the undo history and the
    // cursor, and the document is CodeMirror's state now, not React's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const reload = async () => {
    const fresh = await window.baton.workspaceRead(path);
    const current = view.current;
    if (fresh.kind !== 'text' || !current) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: fresh.text }
    });
    saved.current = fresh.text;
    stamp.current = { mtimeMs: fresh.mtimeMs, bytes: fresh.bytes };
    setConflict(undefined);
    onDirtyChange(false);
    onSaved(stamp.current);
  };

  return (
    <>
      {conflict && (
        <div className="conflict" role="alert">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M12 8v5" /><path d="M12 16.5v.01" /><circle cx="12" cy="12" r="9" />
          </svg>
          <span className="grow">
            This file changed on disk since you opened it — most likely an agent working
            in the same clone.
          </span>
          <button className="ghost" onClick={() => void reload()}>Reload from disk</button>
          <button
            className="primary"
            onClick={() => {
              const current = view.current;
              if (!current) return;
              void window.baton
                .workspaceWrite(path, current.state.doc.toString())
                .then((result) => {
                  if (result.ok) {
                    saved.current = current.state.doc.toString();
                    stamp.current = result.stamp;
                    setConflict(undefined);
                    onDirtyChange(false);
                    onSaved(result.stamp);
                  }
                });
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {error && <div className="conflict error-bar" role="alert">{error}</div>}
      <div className="cm-host" ref={host} />
    </>
  );
}

export function statusFor(path: string): string {
  return languageFor(path) ?? 'plain text';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
