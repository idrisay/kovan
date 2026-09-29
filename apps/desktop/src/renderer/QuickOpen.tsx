/**
 * ⌘P — go to a file by name, as in VS Code (item 100).
 *
 * Opens over whatever you're doing. With nothing typed it lists the files you
 * opened most recently, newest first; typing fuzzy-matches every file in the
 * active workspace ("wsp tsx" finds Workspace.tsx), file names before folders.
 * "name:42" opens at line 42. ↑↓ move, Enter opens, Esc closes, and ⌘P again
 * moves down the list, as VS Code's does.
 *
 * The file list is asked for when the picker opens (see `main/fileIndex.ts`)
 * and not before; recent files show at once, without waiting for it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseQuickQuery, pushRecent, rankPaths, type QuickMatch } from '@baton/core';

const RECENT_KEY = 'baton.recent-files';

export function recentFiles(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Called for every file opened, however it was opened. */
export function rememberFile(path: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(recentFiles(), path))); } catch { /* a convenience */ }
}

interface Row {
  path: string;
  rel: string;
  recent: boolean;
  match?: QuickMatch;
}

/** A small type tag in place of VS Code's file icons, from the extension. */
function tagOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const known: Record<string, string> = {
    ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS', json: '{}', md: 'M↓', py: 'PY', swift: 'SW',
    css: '#', scss: '#', html: '<>', sh: '$', zsh: '$', yml: 'Y', yaml: 'Y', php: 'PHP', go: 'GO', rs: 'RS',
    png: '▣', jpg: '▣', jpeg: '▣', gif: '▣', svg: '▣', icns: '▣'
  };
  return known[ext] ?? '·';
}

/** `text` with the matched positions (offset by `from`) in <mark>. */
function Highlight({ text, from, indices }: { text: string; from: number; indices: number[] }) {
  const hit = new Set(indices.map((i) => i - from).filter((i) => i >= 0 && i < text.length));
  if (hit.size === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let run = '';
  let marked = false;
  const flush = (key: number) => {
    if (run) parts.push(marked ? <mark key={key}>{run}</mark> : <span key={key}>{run}</span>);
    run = '';
  };
  [...text].forEach((ch, i) => {
    if (hit.has(i) !== marked) { flush(i); marked = hit.has(i); }
    run += ch;
  });
  flush(text.length);
  return <>{parts}</>;
}

export function QuickOpen({ onOpen, onClose }: {
  onOpen: (path: string, line?: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<{ path: string; rel: string }[]>();
  const [folders, setFolders] = useState<string[]>();
  const [workspace, setWorkspace] = useState<string | null>();
  const [active, setActive] = useState(0);
  const [recent] = useState(recentFiles);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    void window.baton.workspaces().then(({ list: all, active: id }) => {
      setFolders(all.find((w) => w.id === id)?.folders ?? []);
    });
    void window.baton.quickOpenFiles().then((answer) => {
      setWorkspace(answer.workspace);
      setFiles(answer.files);
    });
  }, []);

  const relOf = useCallback((file: string) => {
    const hit = files?.find((f) => f.path === file);
    if (hit) return hit.rel;
    const folder = folders?.find((f) => file.startsWith(`${f}/`));
    return folder ? file.slice(folder.length + 1) : file;
  }, [files, folders]);

  const { text, line } = parseQuickQuery(query);

  const rows: Row[] = useMemo(() => {
    // Recent files that belong to this workspace — one from another workspace
    // couldn't be opened here.
    const inside = (p: string) => (folders ?? []).some((f) => p.startsWith(`${f}/`));
    const recentHere = recent.filter(inside);
    if (!text) return recentHere.map((p) => ({ path: p, rel: relOf(p), recent: true }));
    const all = files ?? recentHere.map((p) => ({ path: p, rel: relOf(p) }));
    const recentRank = new Map(recentHere.map((p, i) => [p, i]));
    return rankPaths(text, all, (f) => f.rel, 80)
      .map(({ item, match }) => {
        // A file you opened lately wins a close race, the newest most.
        const bonus = recentRank.has(item.path) ? 3 - recentRank.get(item.path)! / 20 : 0;
        return { path: item.path, rel: item.rel, recent: recentRank.has(item.path), match: { ...match, score: match.score + bonus } };
      })
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, 60);
  }, [text, files, folders, recent, relOf]);

  useEffect(() => { setActive(0); }, [text]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    rememberFile(row.path);
    onOpen(row.path, line);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'p' && e.metaKey) || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const empty = workspace === null
    ? 'No workspace yet — add a folder in the Workspace view, and its files show up here.'
    : !text
      ? files ? 'Nothing opened yet. Type to search every file in the workspace.' : 'Type to search files…'
      : files ? `No file matches “${text}”.` : 'Listing files…';

  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <div className="quick-open" role="dialog" aria-label="Go to file" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input} id="quick-open-input" className="quick-open-input" value={query} spellCheck={false}
          placeholder={`Search files by name${workspace ? ` in ${workspace}` : ''} (append : to go to a line)`}
          aria-controls="quick-open-list" aria-activedescendant={rows[active] ? `qo-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
        />
        <div className="quick-open-list" id="quick-open-list" role="listbox" ref={list}>
          {rows.length === 0 && <div className="quick-open-empty">{empty}</div>}
          {rows.map((row, i) => {
            const slash = row.rel.lastIndexOf('/');
            const name = row.rel.slice(slash + 1);
            const dir = slash > 0 ? row.rel.slice(0, slash) : '';
            const indices = row.match?.indices ?? [];
            return (
              <div
                key={row.path} id={`qo-${i}`} role="option" aria-selected={i === active}
                className={`quick-open-row${i === active ? ' active' : ''}`}
                onMouseMove={() => setActive(i)} onClick={() => choose(row)}
              >
                <span className="quick-open-tag">{tagOf(name)}</span>
                <span className="quick-open-name"><Highlight text={name} from={slash + 1} indices={indices} /></span>
                {dir && <span className="quick-open-dir"><Highlight text={dir} from={0} indices={indices} /></span>}
                {row.recent && (!text ? i === 0 : true) && <span className="quick-open-note">recently opened</span>}
              </div>
            );
          })}
        </div>
        {line && rows[active] && <div className="quick-open-foot">Opens at line {line}</div>}
      </div>
    </div>
  );
}
