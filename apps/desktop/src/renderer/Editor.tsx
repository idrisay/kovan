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
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView, GutterMarker, gutter, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection
} from '@codemirror/view';
import type { ChangeMark, ChangeMarkKind } from '@kovan/core';
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
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--clay) 16%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--clay) 22%, transparent)',
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
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--clay) 40%, transparent)' }
});

// --- Change bars (VS Code's quick diff) ----------------------------------------

const CHANGE_LABEL: Record<ChangeMarkKind, string> = {
  added: 'Added since the last commit',
  modified: 'Changed since the last commit',
  deleted: 'Lines removed here'
};

class ChangeBar extends GutterMarker {
  constructor(readonly kind: ChangeMarkKind) { super(); }
  override eq(other: ChangeBar) { return other.kind === this.kind; }
  override toDOM() {
    const bar = document.createElement('div');
    bar.className = `cm-change-bar ${this.kind}`;
    bar.title = CHANGE_LABEL[this.kind];
    return bar;
  }
}

const BARS: Record<ChangeMarkKind, ChangeBar> = {
  added: new ChangeBar('added'), modified: new ChangeBar('modified'), deleted: new ChangeBar('deleted')
};

const setMarks = StateEffect.define<ChangeMark[]>();

/**
 * The bars, as positions in the document. Mapped through every edit, so
 * typing above a changed line carries its bar down with it until the next
 * diff (after a save) replaces them all.
 */
const marksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setMarks)) continue;
      const doc = transaction.state.doc;
      const ranges = effect.value
        // A deletion at the very end points one past the last line.
        .map((m) => ({ ...m, line: Math.min(m.line, doc.lines) }))
        .filter((m) => m.line >= 1)
        .sort((a, b) => a.line - b.line)
        .map((m) => BARS[m.kind].range(doc.line(m.line).from));
      next = RangeSet.of(ranges, true);
    }
    return next;
  }
});

const changeGutter: Extension = [
  marksField,
  gutter({ class: 'cm-change-gutter', markers: (view) => view.state.field(marksField) })
];

export function Editor({
  path,
  body,
  marks,
  revision,
  onDirtyChange,
  onCursor,
  registerSave,
  onSaved,
  goto
}: {
  path: string;
  body: FileBody;
  /** Lines that differ from git's copy, for the change bars. */
  marks?: ChangeMark[];
  /** Bumped when the workspace re-reads git; the editor then checks the disk. */
  revision: number;
  onDirtyChange: (dirty: boolean) => void;
  onCursor: (position: { line: number; column: number; selected: number }) => void;
  registerSave: (save: (() => void) | undefined) => void;
  onSaved: (stamp: FileStamp) => void;
  /** Put the caret on this line and bring it into view — ⌘P's "name:42". */
  goto?: { line: number; nonce: number };
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
      marks={marks}
      revision={revision}
      onDirtyChange={onDirtyChange}
      onCursor={onCursor}
      registerSave={registerSave}
      onSaved={onSaved}
      {...(goto ? { goto } : {})}
    />
  );
}

function CodeEditor({
  path,
  body,
  marks,
  revision,
  onDirtyChange,
  onCursor,
  registerSave,
  onSaved,
  goto
}: {
  path: string;
  body: Extract<FileBody, { kind: 'text' }>;
  marks?: ChangeMark[];
  revision: number;
  onDirtyChange: (dirty: boolean) => void;
  onCursor: (position: { line: number; column: number; selected: number }) => void;
  registerSave: (save: (() => void) | undefined) => void;
  onSaved: (stamp: FileStamp) => void;
  goto?: { line: number; nonce: number };
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
      const result = await window.kovan.workspaceWrite(
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
      changeGutter,
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

  // After the editor above exists, so a file opened at a line lands there.
  useEffect(() => {
    const current = view.current;
    if (!goto || !current) return;
    const line = current.state.doc.line(Math.min(Math.max(1, goto.line), current.state.doc.lines));
    current.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' })
    });
    current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goto?.nonce, path]);

  // Kept in a ref as well: replacing the whole document (a reload) maps every
  // bar away, so the reload puts the latest ones back itself.
  const marksNow = useRef(marks);
  marksNow.current = marks;
  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(marks ?? []) });
  }, [marks]);

  /**
   * Picks up a change on disk, as VS Code does. With no edits of your own the
   * new text simply replaces the old (the cursor stays where it was, as near
   * as the new text allows). With edits, nothing is overwritten: the "changed
   * on disk" bar asks which one wins. Before this, a file an agent had just
   * changed kept showing what it said when its tab was opened.
   */
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision === firstRevision.current) return undefined;
    let cancelled = false;
    void window.kovan.workspaceRead(path).then((fresh) => {
      const current = view.current;
      if (cancelled || fresh.kind !== 'text' || !current) return;
      if (fresh.text === saved.current) {
        stamp.current = { mtimeMs: fresh.mtimeMs, bytes: fresh.bytes };
        return;
      }
      const clean = current.state.doc.toString() === saved.current;
      if (!clean) {
        setConflict({ mtimeMs: fresh.mtimeMs, bytes: fresh.bytes });
        return;
      }
      const head = Math.min(current.state.selection.main.head, fresh.text.length);
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: fresh.text },
        selection: { anchor: head },
        effects: setMarks.of(marksNow.current ?? [])
      });
      saved.current = fresh.text;
      stamp.current = { mtimeMs: fresh.mtimeMs, bytes: fresh.bytes };
      onDirtyChange(false);
      onSaved(stamp.current);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, path]);

  const reload = async () => {
    const fresh = await window.kovan.workspaceRead(path);
    const current = view.current;
    if (fresh.kind !== 'text' || !current) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: fresh.text },
      effects: setMarks.of(marksNow.current ?? [])
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
            <circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />
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
              void window.kovan
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
