/**
 * The workspace: the folders you picked, every clone inside them, their files
 * and their changes.
 *
 * Shaped after VS Code because that shape is already known — explorer, editor
 * tabs, source control. Three things are deliberately different:
 *
 *   - **Files and Changes are separate tabs.** Stacked in one scroller, a repo
 *     with twenty changes pushed the file tree below the fold, so a workspace
 *     looked like it had no folders in it.
 *   - **A repository is a row, not a section.** Eight repos of header + changes
 *     + tree do not fit on a screen; eight rows do.
 *   - **Expansion state and loaded entries live here**, in this component, not
 *     in each level of the tree. See `Tree` for why that matters.
 *
 * Nothing watches the filesystem, and a directory is listed only when it is
 * opened: a workspace over a folder full of `node_modules` must open as fast
 * as one over an empty directory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, formatBytes, statusFor } from './Editor';
import { Diff } from './Diff';
import {
  ChangesIcon, ChevronIcon, CloseIcon, CollapseIcon, FileIcon, FolderIcon,
  PlusIcon, RefreshIcon, TerminalIcon
} from './icons';
import type {
  ChangeKind, DiffSide, Entry, FileBody, FileDiff, Workspace, WorkspaceRepo, WorkspaceStatus
} from './types';

interface Tab {
  key: string;
  kind: 'file' | 'diff';
  title: string;
  /** Absolute for a file tab; repo-relative for a diff tab. */
  path: string;
  repo?: string;
  side?: DiffSide;
  from?: string;
}

const KIND_MARK: Record<ChangeKind, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R',
  copied: 'C', typechange: 'T', conflicted: '!', untracked: 'U'
};

interface Cursor { line: number; column: number; selected: number }

export function WorkspaceView({ onTerminal }: { onTerminal: (cwd: string) => void }) {
  const [list, setList] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string>();
  const [repos, setRepos] = useState<WorkspaceRepo[]>();
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const [pane, setPane] = useState<'files' | 'changes'>('files');
  const [busy, setBusy] = useState(false);

  /**
   * Expansion and the directory cache, owned here rather than per level.
   *
   * The previous tree kept both inside each `Tree` component. Collapsing a
   * folder unmounted its child, taking that child's expansion set *and* its
   * loaded entries with it — so reopening a folder showed everything beneath
   * it shut again, after a fresh round of IPC. Held here, collapsing removes
   * one path and leaves the rest recorded, and a folder opened once never has
   * to be read twice.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Map<string, Entry[]>>(new Map());
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const loading = useRef(new Set<string>());

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [current, setCurrent] = useState<string>();
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<Cursor>();
  const save = useRef<(() => void) | undefined>();

  const workspace = list.find((w) => w.id === active);

  const loadWorkspaces = useCallback(async () => {
    const { list: all, active: id } = await window.baton.workspaces();
    setList(all);
    setActive((previous) => (previous && all.some((w) => w.id === previous) ? previous : id));
  }, []);

  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);

  /**
   * Repos and statuses for the active workspace.
   *
   * `cancelled` matters: switching workspaces twice quickly would otherwise let
   * the first scan resolve last and paint the wrong folder's repositories.
   */
  const loadRepos = useCallback(async (id: string, force = false) => {
    setBusy(true);
    try {
      const found = await window.baton.workspaceRepos(id, force);
      setRepos(found);
      const pairs = await Promise.all(
        found.map(async (r) => [r.path, await window.baton.workspaceStatus(r.path)] as const)
      );
      setStatuses(Object.fromEntries(pairs));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!active) { setRepos([]); setStatuses({}); return undefined; }
    let cancelled = false;
    setRepos(undefined);
    setBusy(true);
    void (async () => {
      const found = await window.baton.workspaceRepos(active);
      if (cancelled) return;
      setRepos(found);
      // One repo expanded by default when it is the only one; with several,
      // the useful first screen is the list of them.
      setExpanded(found.length === 1 && found[0] ? new Set([found[0].path]) : new Set());
      const pairs = await Promise.all(
        found.map(async (r) => [r.path, await window.baton.workspaceStatus(r.path)] as const)
      );
      if (cancelled) return;
      setStatuses(Object.fromEntries(pairs));
      setBusy(false);
    })();
    return () => { cancelled = true; };
  }, [active]);

  /** Loads a directory once, into the shared cache. */
  const ensure = useCallback((dir: string) => {
    if (entries.has(dir) || failed.has(dir) || loading.current.has(dir)) return;
    loading.current.add(dir);
    void window.baton
      .workspaceTree(dir)
      .then((list_) => setEntries((map) => new Map(map).set(dir, list_)))
      .catch((e: Error) => setFailed((map) => new Map(map).set(dir, e.message)))
      .finally(() => loading.current.delete(dir));
  }, [entries, failed]);

  const toggle = useCallback((dir: string) => {
    setExpanded((current_) => {
      const next = new Set(current_);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  /**
   * Closes every folder *and* every repository.
   *
   * Collapsing to "one repo still open" would make the button's effect depend
   * on where you happened to be; landing on the repository list every time is
   * what makes it worth reaching for.
   */
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const refresh = useCallback(() => {
    if (!active) return;
    setEntries(new Map());
    setFailed(new Map());
    void loadRepos(active, true);
  }, [active, loadRepos]);

  /** Absolute path → change kind, so the tree can mark what git sees. */
  const changed = useMemo(() => {
    const map = new Map<string, ChangeKind>();
    for (const [repoPath, status] of Object.entries(statuses)) {
      for (const change of [...status.staged, ...status.unstaged, ...status.untracked]) {
        map.set(`${repoPath}/${change.path}`, change.kind);
      }
    }
    return map;
  }, [statuses]);

  /**
   * Directories with a change somewhere beneath them.
   *
   * Every ancestor of every changed file, so a collapsed folder can say that
   * there is work inside it without being opened.
   */
  const dirtyDirs = useMemo(() => {
    const set = new Set<string>();
    for (const file of changed.keys()) {
      let dir = file.slice(0, file.lastIndexOf('/'));
      while (dir.length > 1 && !set.has(dir)) {
        set.add(dir);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    }
    return set;
  }, [changed]);

  const open = useCallback((tab: Tab) => {
    setTabs((existing) => (existing.some((t) => t.key === tab.key) ? existing : [...existing, tab]));
    setCurrent(tab.key);
  }, []);

  const openFile = useCallback((entry: Entry) =>
    open({ key: `file:${entry.path}`, kind: 'file', title: entry.name, path: entry.path }), [open]);

  const openDiff = useCallback((repo: string, file: string, side: DiffSide, from?: string) =>
    open({
      // The side is part of the identity: the staged and the unstaged diff of
      // one file are two different things and must be two tabs.
      key: `diff:${side}:${repo}/${file}`,
      kind: 'diff',
      title: file.split('/').pop() || file,
      path: file, repo, side, ...(from ? { from } : {})
    }), [open]);

  const close = useCallback((key: string) => {
    setTabs((existing) => {
      const index = existing.findIndex((t) => t.key === key);
      const next = existing.filter((t) => t.key !== key);
      setCurrent((active_) =>
        active_ === key ? next[Math.min(index, next.length - 1)]?.key : active_);
      return next;
    });
    setDirty((d) => { const n = new Set(d); n.delete(key); return n; });
  }, []);

  const tab = tabs.find((t) => t.key === current);

  const markDirty = useCallback((key: string, value: boolean) => {
    setDirty((d) => {
      if (d.has(key) === value) return d;
      const n = new Set(d);
      if (value) n.add(key); else n.delete(key);
      return n;
    });
  }, []);

  const totalChanges = useMemo(
    () => Object.values(statuses).reduce((sum, s) => sum + s.changes, 0),
    [statuses]
  );

  return (
    <>
      <aside className="queue explorer" aria-label="Explorer">
        <div className="queue-head">
          <div className="queue-title-row">
            <h1>Workspace</h1>
            <button
              type="button" className="icon-button boxed" aria-label="Collapse all"
              title="Collapse all" disabled={expanded.size === 0} onClick={collapseAll}
            >
              <CollapseIcon />
            </button>
            <button
              type="button" className="icon-button" aria-label="Refresh workspace"
              disabled={!active || busy} onClick={refresh}
            >
              <RefreshIcon size={14} />
            </button>
          </div>

          <div className="ws-picker">
            <select
              aria-label="Active workspace"
              value={active ?? ''}
              disabled={list.length === 0}
              onChange={(e) => {
                setActive(e.target.value);
                void window.baton.workspaceActivate(e.target.value);
              }}
            >
              {list.length === 0 && <option value="">No workspace</option>}
              {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            {repos && repos.length > 0 && (
              <span className="ws-repo-count">{repos.length} repo{repos.length === 1 ? '' : 's'}</span>
            )}
            <button
              type="button" className="icon-button" aria-label="New workspace"
              onClick={() => void window.baton.workspaceCreate().then(async (made) => {
                if (!made) return;
                await loadWorkspaces();
                setActive(made.id);
              })}
            >
              <PlusIcon size={13} />
            </button>
          </div>

          {workspace && (
            <div className="segmented" role="tablist" aria-label="Explorer view">
              <button
                type="button" role="tab" aria-selected={pane === 'files'}
                className={pane === 'files' ? 'seg on' : 'seg'} onClick={() => setPane('files')}
              >
                Files
              </button>
              <button
                type="button" role="tab" aria-selected={pane === 'changes'}
                className={pane === 'changes' ? 'seg on' : 'seg'} onClick={() => setPane('changes')}
              >
                Changes
                {totalChanges > 0 && <span className="seg-count">{totalChanges}</span>}
              </button>
            </div>
          )}
        </div>

        <div className="queue-list">
          {!workspace ? (
            <NoWorkspace onCreate={() => void window.baton.workspaceCreate().then(async (made) => {
              if (!made) return;
              await loadWorkspaces();
              setActive(made.id);
            })} />
          ) : repos === undefined ? (
            <Skeleton label="Looking for repositories…" />
          ) : repos.length === 0 ? (
            <NoRepos workspace={workspace} onAdd={() =>
              void window.baton.workspaceAddFolder(workspace.id).then((updated) => {
                if (updated) { void loadWorkspaces(); refresh(); }
              })} />
          ) : (
            repos.map((repo) => (
              <RepoRow
                key={repo.path}
                repo={repo}
                status={statuses[repo.path]}
                open={expanded.has(repo.path)}
                onToggle={() => toggle(repo.path)}
                onTerminal={() => onTerminal(repo.path)}
              >
                {pane === 'files' ? (
                  <Tree
                    dir={repo.path} depth={0}
                    expanded={expanded} entries={entries} failed={failed}
                    changed={changed} dirtyDirs={dirtyDirs} dirtyTabs={dirty}
                    ensure={ensure} onToggle={toggle} onOpenFile={openFile}
                  />
                ) : (
                  <ChangeList
                    repo={repo} status={statuses[repo.path]}
                    selected={tab?.kind === 'diff' ? `${tab.repo}/${tab.path}` : undefined}
                    onOpen={openDiff}
                  />
                )}
              </RepoRow>
            ))
          )}
        </div>
      </aside>

      <main className="pane editor-pane">
        {tabs.length === 0 ? (
          <p className="quiet centred">
            {workspace
              ? 'Pick a file to read or edit it, or a change to see the diff.'
              : 'Create a workspace to browse your repositories.'}
          </p>
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="Open files">
              {tabs.map((t) => (
                <div
                  key={t.key} role="tab" aria-selected={t.key === current}
                  className={t.key === current ? 'tab active' : 'tab'}
                  onMouseDown={(e) => {
                    // Middle-click closes, as it does in every editor.
                    if (e.button === 1) { e.preventDefault(); close(t.key); }
                  }}
                >
                  <button className="tab-label" onClick={() => setCurrent(t.key)}>
                    {t.kind === 'diff' && <ChangesIcon size={11} />}
                    <span>{t.title}</span>
                    {t.kind === 'diff' && <span className="tab-side">{t.side}</span>}
                  </button>
                  {dirty.has(t.key) ? (
                    // A dot where the close button was, so an unsaved tab
                    // cannot be shut by the muscle memory that shuts a saved one.
                    <span className="tab-dirty" title="Unsaved changes" aria-label="Unsaved changes" />
                  ) : (
                    <button
                      className="tab-close" aria-label={`Close ${t.title}`}
                      onClick={() => close(t.key)}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {tab && (
              <TabBody
                key={tab.key}
                tab={tab}
                cursor={cursor}
                dirty={dirty.has(tab.key)}
                onDirty={(value) => markDirty(tab.key, value)}
                onCursor={setCursor}
                registerSave={(fn) => { save.current = fn; }}
                onSave={() => save.current?.()}
              />
            )}
          </>
        )}
      </main>
    </>
  );
}

// --- Explorer -----------------------------------------------------------------

function RepoRow({
  repo, status, open, onToggle, onTerminal, children
}: {
  repo: WorkspaceRepo;
  status?: WorkspaceStatus;
  open: boolean;
  onToggle: () => void;
  onTerminal: () => void;
  children: React.ReactNode;
}) {
  const count = status?.changes;
  return (
    <section className="ws-root">
      <div className={open ? 'repo open' : 'repo'}>
        <button className="repo-main" onClick={onToggle} aria-expanded={open}>
          <ChevronIcon open={open} size={11} />
          <span className="repo-name">{repo.name}</span>
          {repo.branch && <span className="repo-branch">{repo.branch}</span>}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="repo-ab">
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.behind > 0 && `↓${status.behind}`}
            </span>
          )}
          <span className="spacer" />
          {count === undefined ? (
            <span className="repo-pill quiet-pill">·</span>
          ) : count > 0 ? (
            <span className="repo-pill dirty">{count}</span>
          ) : (
            <span className="repo-pill quiet-pill">clean</span>
          )}
        </button>
        <button
          className="icon-button" aria-label={`Open a terminal in ${repo.name}`}
          onClick={onTerminal}
        >
          <TerminalIcon size={13} />
        </button>
      </div>
      {open && <div className="repo-body">{children}</div>}
    </section>
  );
}

/**
 * One directory level.
 *
 * It owns no state at all — expansion, entries and errors are passed in. That
 * is the whole fix: a level can unmount without taking anything with it, so
 * collapsing a folder no longer resets everything beneath it.
 */
function Tree({
  dir, depth, expanded, entries, failed, changed, dirtyDirs, dirtyTabs, ensure, onToggle, onOpenFile
}: {
  dir: string;
  depth: number;
  expanded: Set<string>;
  entries: Map<string, Entry[]>;
  failed: Map<string, string>;
  changed: Map<string, ChangeKind>;
  dirtyDirs: Set<string>;
  dirtyTabs: Set<string>;
  ensure: (dir: string) => void;
  onToggle: (dir: string) => void;
  onOpenFile: (entry: Entry) => void;
}) {
  useEffect(() => { ensure(dir); }, [dir, ensure]);

  const error = failed.get(dir);
  const list = entries.get(dir);

  if (error) return <p className="tree-note error">{error}</p>;
  // Placeholders, never a replacement for the level: the tree above this one
  // has to stay on screen while a slow directory is read.
  if (!list) return <Skeleton rows={2} inline />;
  if (list.length === 0) return <p className="tree-note">empty</p>;

  return (
    <ul className="tree">
      {list.map((entry) => {
        const open = expanded.has(entry.path);
        const mark = changed.get(entry.path);
        const inside = entry.directory && !open && dirtyDirs.has(entry.path);
        const unsaved = dirtyTabs.has(`file:${entry.path}`);
        return (
          <li key={entry.path}>
            <button
              className={mark ? `tree-row changed ${mark}` : 'tree-row'}
              onClick={() => (entry.directory ? onToggle(entry.path) : onOpenFile(entry))}
              {...(entry.directory ? { 'aria-expanded': open } : {})}
            >
              {entry.directory
                ? <ChevronIcon open={open} size={11} />
                : <span className="tree-spacer" />}
              {entry.directory ? <FolderIcon size={13} /> : <FileIcon size={13} />}
              <span className="tree-name">{entry.name}</span>
              {unsaved && <span className="tree-unsaved" title="Unsaved changes" />}
              {inside && <span className="tree-dot" title="Changes inside" />}
              {mark && <span className="tree-mark">{KIND_MARK[mark]}</span>}
            </button>
            {entry.directory && open && (
              <div className="tree-children">
                <Tree
                  dir={entry.path} depth={depth + 1}
                  expanded={expanded} entries={entries} failed={failed}
                  changed={changed} dirtyDirs={dirtyDirs} dirtyTabs={dirtyTabs}
                  ensure={ensure} onToggle={onToggle} onOpenFile={onOpenFile}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Staged / Changes / Untracked, the grouping git itself uses. */
function ChangeList({
  repo, status, selected, onOpen
}: {
  repo: WorkspaceRepo;
  status?: WorkspaceStatus;
  selected?: string;
  onOpen: (repo: string, file: string, side: DiffSide, from?: string) => void;
}) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  if (!status) return <Skeleton rows={2} inline />;

  const groups = [
    { id: 'staged', label: 'Staged', rows: status.staged, tone: 'pass' },
    { id: 'unstaged', label: 'Changes', rows: status.unstaged, tone: 'running' },
    { id: 'untracked', label: 'Untracked', rows: status.untracked, tone: 'pass' }
  ].filter((g) => g.rows.length > 0);

  if (groups.length === 0) {
    return (
      <p className="tree-note clean">
        <span className="dot pass" /> Working tree clean
      </p>
    );
  }

  return (
    <>
      {groups.map((group) => {
        const open = !shut.has(group.id);
        return (
          <div key={group.id}>
            <button
              className="change-group" aria-expanded={open}
              onClick={() => setShut((s) => {
                const n = new Set(s);
                if (n.has(group.id)) n.delete(group.id); else n.add(group.id);
                return n;
              })}
            >
              <ChevronIcon open={open} size={11} />
              <span>{group.label}</span>
              <span className={`group-count ${group.tone}`}>{group.rows.length}</span>
            </button>
            {open && (
              <ul className="rows changes">
                {group.rows.map((change) => {
                  const id = `${repo.path}/${change.path}`;
                  return (
                    <li key={`${change.side}:${change.path}`}>
                      <button
                        className={selected === id ? 'change selected' : 'change'}
                        onClick={() => onOpen(repo.path, change.path, change.side, change.from)}
                        title={change.from ? `${change.from} → ${change.path}` : change.path}
                      >
                        <span className={`change-mark ${change.kind}`}>{KIND_MARK[change.kind]}</span>
                        <span className="change-name">{baseOf(change.path)}</span>
                        <span className="change-dir"><bdi>{dirOf(change.path)}</bdi></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}

function Skeleton({ rows = 3, label, inline = false }: {
  rows?: number; label?: string; inline?: boolean;
}) {
  return (
    <div className={inline ? 'skeleton inline' : 'skeleton'} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="shimmer" style={{ width: `${70 - i * 12}%` }} />
      ))}
      {label && <p className="tree-note">{label}</p>}
    </div>
  );
}

function NoWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="ws-empty">
      <p className="quiet">
        A workspace is a folder Baton looks inside. It finds every git clone under it, so you
        can read — and edit — the code behind a ticket without leaving the app.
      </p>
      <button className="primary" onClick={onCreate}>Choose a folder</button>
    </div>
  );
}

function NoRepos({ workspace, onAdd }: { workspace: Workspace; onAdd: () => void }) {
  return (
    <div className="ws-empty">
      <p className="quiet">
        No git clones under <span className="key">{workspace.folders.join(', ')}</span>.
      </p>
      <button className="ghost" onClick={onAdd}>Add a folder</button>
    </div>
  );
}

// --- Tab bodies ---------------------------------------------------------------

function TabBody({
  tab, cursor, dirty, onDirty, onCursor, registerSave, onSave
}: {
  tab: Tab;
  cursor?: Cursor;
  dirty: boolean;
  onDirty: (value: boolean) => void;
  onCursor: (c: Cursor) => void;
  registerSave: (fn: (() => void) | undefined) => void;
  onSave: () => void;
}) {
  const [body, setBody] = useState<FileBody>();
  const [diff, setDiff] = useState<FileDiff>();
  const [error, setError] = useState<string>();
  /** Updated on every save, so the size shown is the size on disk. */
  const [bytes, setBytes] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    setBody(undefined); setDiff(undefined); setError(undefined); setBytes(undefined);
    const load = tab.kind === 'file'
      ? window.baton.workspaceRead(tab.path).then((b) => { if (!cancelled) setBody(b); })
      : window.baton.workspaceDiff(tab.repo!, tab.path, tab.side!, tab.from)
          .then((d) => { if (!cancelled) setDiff(d); });
    void load.catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tab]);

  if (error) return <p className="quiet centred error">{error}</p>;

  return (
    <div className="tab-body">
      <div className="tab-path">
        <bdi>{tab.kind === 'file' ? tab.path : `${tab.repo}/${tab.path}`}</bdi>
      </div>

      {tab.kind === 'file' ? (
        body ? (
          <>
            <Editor
              path={tab.path} body={body}
              onDirtyChange={onDirty} onCursor={onCursor} registerSave={registerSave}
              onSaved={(next) => setBytes(next.bytes)}
            />
            <div className="status-bar">
              {cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>}
              {cursor && cursor.selected > 0 && <span>Sel {cursor.selected}</span>}
              <span>{statusFor(tab.path)}</span>
              <span>{formatBytes(bytes ?? body.bytes)}</span>
              <span className="spacer" />
              {dirty ? (
                <button className="save" onClick={onSave}>Save <kbd>⌘S</kbd></button>
              ) : (
                <span className="saved">saved</span>
              )}
            </div>
          </>
        ) : <Skeleton rows={4} label="Reading…" />
      ) : diff ? (
        <Diff path={tab.path} side={tab.side!} from={tab.from} diff={diff} />
      ) : (
        <Skeleton rows={4} label="Diffing…" />
      )}
    </div>
  );
}

/**
 * Git reports an untracked *directory* with a trailing slash; splitting that on
 * "/" yields an empty last segment, which rendered as a row with no name.
 */
function baseOf(p: string): string {
  const directory = p.endsWith('/');
  const name = (directory ? p.slice(0, -1) : p).split('/').pop() ?? p;
  return directory ? `${name}/` : name;
}

function dirOf(p: string): string {
  const clean = p.endsWith('/') ? p.slice(0, -1) : p;
  const index = clean.lastIndexOf('/');
  return index === -1 ? '' : clean.slice(0, index);
}
