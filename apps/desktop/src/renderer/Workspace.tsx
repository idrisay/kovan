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

import { isMac, keyLabel } from './platform';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changeMarks, moveBy, moveItem, type ChangeMark } from '@kovan/core';
import { useMenuDismiss } from './menuDismiss';
import { Editor, formatBytes, statusFor } from './Editor';
import { rememberFile } from './QuickOpen';
import { Diff } from './Diff';
import { Resizer } from './Resizer';
import {
  AddFolderIcon, ChangesIcon, ChevronIcon, CloseIcon, CollapseIcon, FileIcon,
  FolderIcon, MoreIcon, RefreshIcon, RevertIcon, TerminalIcon
} from './icons';
import type {
  ChangeKind, DiffSide, Entry, FileBody, FileChange, FileDiff, Root, Workspace, WorkspaceRepo,
  SessionInfo, WorkspaceStatus
} from './types';
import { InlineTerminal } from './Detail';
import { useTerminalToggle } from './terminalToggle';

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

/** A file to open in the Workspace view: in the editor, or its diff when `diff` says which. */
export interface OpenRequest {
  path: string;
  line?: number;
  diff?: { repo: string; file: string; side: DiffSide };
  nonce: number;
}

export function WorkspaceView({ sessions, visible, openRequest, showRequest }: {
  /** For the terminal docked under the editor (item 158). */
  sessions: SessionInfo[];
  /** The Dock menu (item 135): switch to this workspace, opened at `folder`. */
  showRequest?: { id: string; folder?: string; nonce: number };
  /** ⌘P picked a file (item 100): open it, at a line if one was typed. */
  openRequest?: OpenRequest;
  /**
   * App keeps this view mounted once opened and only hides it, so coming back
   * finds the same Files/Changes tab, open repositories, editor tabs and
   * scroll position — even unsaved edits. It used to unmount on every rail
   * switch and come back with everything reset.
   */
  visible: boolean;
}) {
  const [list, setList] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string>();
  const [roots, setRoots] = useState<Root[]>();
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const [pane, setPane] = useState<'files' | 'changes'>('files');
  const [busy, setBusy] = useState(false);
  /** The workspace row itself collapses, so a long folder list can be hidden. */
  const [shutRoot, setShutRoot] = useState(false);

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
    const { list: all, active: id } = await window.kovan.workspaces();
    setList(all);
    setActive((previous) => (previous && all.some((w) => w.id === previous) ? previous : id));
  }, []);

  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);

  /**
   * Bumped every time git status is read again. The open tab listens: a diff
   * re-reads itself and an editor checks the disk. Before this, a tab showed
   * whatever was true when it was opened — a diff opened while an agent had
   * its work stashed or just committed said "No changes in this file" for as
   * long as it stayed open, next to a list saying the file was modified.
   */
  const [revision, setRevision] = useState(0);

  /** Git status for every repo again; `bump` tells the open tab to follow. */
  const refreshStatuses = useCallback(async (bump = true) => {
    if (!roots) return;
    const pairs = await Promise.all(
      reposOf(roots).map(async (r) => [r.path, await window.kovan.workspaceStatus(r.path)] as const)
    );
    setStatuses(Object.fromEntries(pairs));
    if (bump) setRevision((r) => r + 1);
  }, [roots]);

  /**
   * Coming back to a view that stayed mounted, or to the window: re-read git
   * status (local and cheap — the same call opening the view always made) so
   * work an agent did meanwhile shows up, in the list and in the open tab.
   * VS Code does the same on focus. The repository scan and the file tree are
   * left as they were; Refresh redoes those.
   */
  const shown = useRef(visible);
  useEffect(() => {
    const returning = visible && !shown.current;
    shown.current = visible;
    if (returning) void refreshStatuses();
  }, [visible, refreshStatuses]);
  useEffect(() => {
    if (!visible) return undefined;
    const onFocus = () => void refreshStatuses();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible, refreshStatuses]);

  /**
   * Repos and statuses for the active workspace.
   *
   * `cancelled` matters: switching workspaces twice quickly would otherwise let
   * the first scan resolve last and paint the wrong folder's repositories.
   */
  const reposOf = (list: Root[]) =>
    list.flatMap((root) => (root.repo ? [root.repo, ...root.inside] : root.inside));

  const loadRoots = useCallback(async (id: string, force = false) => {
    setBusy(true);
    try {
      const found = await window.kovan.workspaceRoots(id, force);
      setRoots(found);
      const pairs = await Promise.all(
        reposOf(found).map(
          async (r) => [r.path, await window.kovan.workspaceStatus(r.path)] as const
        )
      );
      setStatuses(Object.fromEntries(pairs));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!active) { setRoots([]); setStatuses({}); return undefined; }
    let cancelled = false;
    setRoots(undefined);
    setBusy(true);
    void (async () => {
      const found = await window.kovan.workspaceRoots(active);
      if (cancelled) return;
      setRoots(found);
      // Every folder of the workspace starts open. That is the whole point of
      // a multi-folder workspace: you see all of them at once, without
      // switching anything.
      setExpanded(new Set(found.map((r) => r.folder)));
      const pairs = await Promise.all(
        reposOf(found).map(
          async (r) => [r.path, await window.kovan.workspaceStatus(r.path)] as const
        )
      );
      if (cancelled) return;
      setStatuses(Object.fromEntries(pairs));
      setBusy(false);
    })();
    return () => { cancelled = true; };
  }, [active]);

  /**
   * A pick from the Dock menu. Main has already made it the active workspace,
   * so this only follows: the list again (it may be a workspace this view has
   * not seen yet), then, once that workspace's folders are in, the folder
   * opened and scrolled to.
   */
  const shownRequest = useRef<number>();
  useEffect(() => {
    if (!showRequest || shownRequest.current === showRequest.nonce || showRequest.id === active) return;
    void window.kovan.workspaces().then(({ list: all }) => { setList(all); setActive(showRequest.id); });
  }, [showRequest, active]);
  useEffect(() => {
    const request = showRequest;
    if (!request || shownRequest.current === request.nonce || request.id !== active || !roots) return;
    const folder = request.folder;
    // Still the previous workspace's folders, the instant after switching.
    if (folder && !roots.some((r) => r.folder === folder)) return;
    shownRequest.current = request.nonce;
    if (!folder) return;
    setExpanded((previous) => new Set(previous).add(folder));
    requestAnimationFrame(() => document
      .querySelector(`[data-root-row="${CSS.escape(folder)}"]`)
      ?.scrollIntoView({ block: 'start' }));
  }, [showRequest, active, roots]);

  /** Loads a directory once, into the shared cache. */
  const ensure = useCallback((dir: string) => {
    if (entries.has(dir) || failed.has(dir) || loading.current.has(dir)) return;
    loading.current.add(dir);
    void window.kovan
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
    void loadRoots(active, true).then(() => setRevision((r) => r + 1));
  }, [active, loadRoots]);

  const createWorkspace = useCallback(() => {
    void window.kovan.workspaceCreate().then(async (made) => {
      if (!made) return;
      await loadWorkspaces();
      setActive(made.id);
    });
  }, [loadWorkspaces]);

  const addFolder = useCallback(() => {
    if (!active) return;
    void window.kovan.workspaceAddFolder(active).then(async (updated) => {
      if (!updated) return;
      await loadWorkspaces();
      // Force, because the repo scan is cached per workspace and the new
      // folder is exactly the thing the cache has not seen.
      await loadRoots(active, true);
    });
  }, [active, loadWorkspaces, loadRoots]);

  /**
   * Stops listing a folder. Nothing on disk is touched — which is why this
   * needs no confirmation and why every label says "remove from workspace".
   */
  const removeFolder = useCallback((folder: string) => {
    if (!active) return;
    void window.kovan.workspaceRemoveFolder(active, folder).then(async (updated) => {
      if (!updated) return;
      await loadWorkspaces();
      await loadRoots(active, true);
    });
  }, [active, loadWorkspaces, loadRoots]);

  /**
   * A new order for the workspace's folders, from a drag or ⌥↑ / ⌥↓. Shown at
   * once, then stored in the workspace itself, so it holds everywhere the
   * workspace does. If main refuses it (the folder list changed meanwhile),
   * the rows go back to what is actually stored.
   */
  const reorderRoots = useCallback((order: string[]) => {
    if (!active || !roots) return;
    const byFolder = new Map(roots.map((r) => [r.folder, r]));
    setRoots(order.flatMap((f) => byFolder.get(f) ?? []));
    void window.kovan.workspaceReorder(active, order).then(async (updated) => {
      if (updated) await loadWorkspaces();
      else await loadRoots(active, true);
    });
  }, [active, roots, loadWorkspaces, loadRoots]);

  const folderOrder = useMemo(() => roots?.map((r) => r.folder) ?? [], [roots]);
  const rootDrag = useRowDrag('data-root-row', (folder, target, after) =>
    reorderRoots(moveItem(folderOrder, folder, target, after)));
  const moveRootBy = useCallback((folder: string, delta: -1 | 1) => {
    const next = moveBy(folderOrder, folder, delta);
    if (next.every((f, i) => f === folderOrder[i])) return;
    reorderRoots(next);
    // The row's DOM node moves, which can drop focus; put it back so a second
    // ⌥↓ keeps going.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        `[data-root-row="${CSS.escape(folder)}"] .repo-main`
      )?.focus();
    });
  }, [folderOrder, reorderRoots]);

  const renameWorkspace = useCallback((name: string) => {
    if (!active) return;
    void window.kovan.workspaceRename(active, name).then(() => void loadWorkspaces());
  }, [active, loadWorkspaces]);

  const forgetWorkspace = useCallback(() => {
    if (!active) return;
    void window.kovan.workspaceForget(active).then(async () => {
      setActive(undefined);
      await loadWorkspaces();
    });
  }, [active, loadWorkspaces]);

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
    // Clicking a change whose tab is already open reads it again, rather than
    // showing what it said last time.
    if (tabs.some((t) => t.key === tab.key)) setRevision((r) => r + 1);
    setTabs((existing) => (existing.some((t) => t.key === tab.key) ? existing : [...existing, tab]));
    setCurrent(tab.key);
  }, [tabs]);

  const openFile = useCallback((entry: Entry) => {
    // Every file opened counts as recent for ⌘P, not only ones opened there.
    rememberFile(entry.path);
    open({ key: `file:${entry.path}`, kind: 'file', title: entry.name, path: entry.path });
  }, [open]);

  const [jump, setJump] = useState<{ path: string; line: number; nonce: number }>();

  const openDiff = useCallback((repo: string, file: string, side: DiffSide, from?: string) =>
    open({
      // The side is part of the identity: the staged and the unstaged diff of
      // one file are two different things and must be two tabs.
      key: `diff:${side}:${repo}/${file}`,
      kind: 'diff',
      title: file.split('/').pop() || file,
      path: file, repo, side, ...(from ? { from } : {})
    }), [open]);

  const handled = useRef<number>();
  useEffect(() => {
    if (!openRequest || handled.current === openRequest.nonce) return;
    handled.current = openRequest.nonce;
    if (openRequest.diff) {
      openDiff(openRequest.diff.repo, openRequest.diff.file, openRequest.diff.side);
      return;
    }
    openFile({ name: openRequest.path.split('/').pop() || openRequest.path, path: openRequest.path, directory: false });
    if (openRequest.line) setJump({ path: openRequest.path, line: openRequest.line, nonce: openRequest.nonce });
  }, [openRequest, openFile, openDiff]);

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

  /** Longest first, so a clone nested in another resolves to itself. */
  const repoPaths = useMemo(
    () => (roots ? reposOf(roots).map((r) => r.path).sort((a, b) => b.length - a.length) : []),
    [roots]
  );
  const repoOf = (file: string) => repoPaths.find((r) => file.startsWith(`${r}/`));

  /**
   * The terminal docked under the editor (item 158), one per workspace, as
   * VS Code's panel: ⌘J and the folder rows' terminal buttons open it here
   * instead of sending you to Sessions. Hiding it leaves the shell running;
   * its close button ends it.
   */
  const [terminals, setTerminals] = useState<Record<string, string>>({});
  const [terminalShown, setTerminalShown] = useState(true);
  const terminal = active ? sessions.find((s) => s.id === terminals[active]) : undefined;
  // A second ⌘J while a shell is still starting would start another.
  const opening = useRef(false);
  const openTerminalAt = useCallback((cwd: string) => {
    const ws = active;
    if (!ws || opening.current) return;
    opening.current = true;
    void window.kovan.openTerminal(cwd).then((session) => {
      setTerminals((t) => ({ ...t, [ws]: session.id }));
      setTerminalShown(true);
    }).finally(() => { opening.current = false; });
  }, [active]);
  useTerminalToggle(() => {
    if (terminal?.running) { setTerminalShown((v) => !v); return; }
    // Where you are: the open file's repository, else the first folder.
    const here = tab ? (tab.kind === 'file' ? repoOf(tab.path) : tab.repo) : undefined;
    const first = roots?.[0];
    const cwd = here ?? first?.repo?.path ?? first?.folder;
    if (cwd) openTerminalAt(cwd);
  }, visible);

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

  const [reverting, setReverting] = useState(false);

  /**
   * Rolls back `changes` in `repoPath` — one row, or every row "Revert all"
   * passes. Closes any open diff tab pointing at what just got discarded (it
   * would otherwise try to diff a change that no longer exists) and refetches
   * just that repo's status, rather than waiting for the next scan.
   */
  const revert = useCallback(async (repoPath: string, changesToRevert: FileChange[]) => {
    setReverting(true);
    try {
      await window.kovan.workspaceRevert(repoPath, changesToRevert);
      for (const c of changesToRevert) {
        close(`diff:${c.side}:${repoPath}/${c.path}`);
      }
      const fresh = await window.kovan.workspaceStatus(repoPath);
      setStatuses((s) => ({ ...s, [repoPath]: fresh }));
      setRevision((r) => r + 1);
    } finally {
      setReverting(false);
    }
  }, [close]);

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
            <NoWorkspace onCreate={createWorkspace} />
          ) : (
            <>
              {/*
                The workspace itself is a row, the way VS Code draws a
                multi-root workspace. There is no switcher in the way, because
                a workspace holds every folder you care about at once — the
                dropdown that used to sit here turned into a repo switcher the
                moment somebody made one workspace per repository.
              */}
              <WorkspaceRow
                workspace={workspace}
                others={list.filter((w) => w.id !== workspace.id)}
                folders={roots?.length ?? 0}
                open={!shutRoot}
                onToggle={() => setShutRoot((v) => !v)}
                onAddFolder={addFolder}
                onSwitch={(id) => { setActive(id); void window.kovan.workspaceActivate(id); }}
                onCreate={createWorkspace}
                onRename={renameWorkspace}
                onForget={forgetWorkspace}
              />

              {!shutRoot && (
                roots === undefined ? (
                  <Skeleton rows={3} label="Looking for repositories…" />
                ) : roots.length === 0 ? (
                  <div className="ws-empty">
                    <p className="quiet">This workspace has no folders yet.</p>
                    <button className="primary" onClick={addFolder}>Add a folder</button>
                  </div>
                ) : (
                  roots.map((root) => (
                    <RootRow
                      key={root.folder}
                      root={root}
                      statuses={statuses}
                      expanded={expanded}
                      onToggle={toggle}
                      onRemove={() => removeFolder(root.folder)}
                      onTerminal={openTerminalAt}
                      drop={rootDrag.drop?.target === root.folder ? (rootDrag.drop.after ? 'after' : 'before') : undefined}
                      dragging={rootDrag.drop?.id === root.folder}
                      onDragStart={(e) => rootDrag.start(root.folder, e)}
                      onMove={(delta) => moveRootBy(root.folder, delta)}
                      renderRepo={(repo) => (
                        pane === 'files' ? (
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
                            onRevert={(changes) => revert(repo.path, changes)}
                            busy={reverting}
                          />
                        )
                      )}
                      renderPlain={(folder) => (
                        pane === 'files' ? (
                          <Tree
                            dir={folder} depth={0}
                            expanded={expanded} entries={entries} failed={failed}
                            changed={changed} dirtyDirs={dirtyDirs} dirtyTabs={dirty}
                            ensure={ensure} onToggle={toggle} onOpenFile={openFile}
                          />
                        ) : (
                          <p className="tree-note">Not a git repository.</p>
                        )
                      )}
                    />
                  ))
                )
              )}
            </>
          )}
        </div>
      </aside>
      <Resizer />

      <main className="pane editor-pane">
        <div className="detail-shell">
        <div className="ws-editor-area">
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
                revision={revision}
                repo={tab.kind === 'file' ? repoOf(tab.path) : tab.repo}
                untracked={changed.get(tab.path) === 'untracked'}
                onOpenFile={(file) => open({
                  key: `file:${file}`, kind: 'file', title: file.split('/').pop() || file, path: file
                })}
                {...(jump && tab.kind === 'file' && jump.path === tab.path ? { goto: { line: jump.line, nonce: jump.nonce } } : {})}
                onStatus={() => void refreshStatuses(false)}
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
        </div>
        {terminal?.running && terminalShown && (
          <InlineTerminal session={terminal} onHide={() => setTerminalShown(false)} />
        )}
        </div>
      </main>
    </>
  );
}

// --- Explorer -----------------------------------------------------------------

function RepoRow({
  repo, status, open, onToggle, onTerminal, onRemove, order, children
}: {
  repo: WorkspaceRepo;
  status?: WorkspaceStatus;
  open: boolean;
  onToggle: () => void;
  onTerminal: () => void;
  /** Present only when this repo *is* a workspace folder, so removable. */
  onRemove?: () => void;
  /** Present only when this repo *is* a workspace folder, so reorderable. */
  order?: Reorderable;
  children: React.ReactNode;
}) {
  const count = status?.changes;
  // "acme/acme-backend": the owner is usually the same on every row, so
  // it steps back and the repository's own name is what the eye lands on.
  const slash = repo.name.lastIndexOf('/');
  const owner = slash === -1 ? '' : repo.name.slice(0, slash + 1);
  const short = repo.name.slice(slash + 1);
  return (
    <section {...sectionProps(order)}>
      <div className={open ? 'repo open' : 'repo'}>
        <button
          className="repo-main" onClick={onToggle} aria-expanded={open}
          title={order ? `${repo.path}\nDrag, or ⌥↑ / ⌥↓, to reorder` : repo.path}
          onKeyDown={order && moveKeys(order)}
        >
          <ChevronIcon open={open} size={11} />
          <span className="repo-name">
            {owner && <span className="repo-owner">{owner}</span>}
            {short}
          </span>
          {repo.branch && <span className="repo-branch">{repo.branch}</span>}
          <span className="spacer" />
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="repo-ab" title={aheadBehind(status)}>
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.behind > 0 && `↓${status.behind}`}
            </span>
          )}
          {/* Rule 6 with the word in the tooltip: a column of "clean" on
              every row was the loudest thing in the list and said the least. */}
          {count === undefined ? null : count > 0 ? (
            <span className="repo-pill dirty" title={`${count} uncommitted change${count === 1 ? '' : 's'}`}>
              {count}
            </span>
          ) : (
            <span className="dot pass" title="Clean — no uncommitted changes" aria-label="clean" />
          )}
        </button>
        <button
          className="icon-button reveal" aria-label={`Open a terminal in ${repo.name}`}
          title="Open a terminal here" onClick={onTerminal}
        >
          <TerminalIcon size={13} />
        </button>
        {onRemove && (
          <button
            className="icon-button reveal remove"
            aria-label={`Remove ${repo.name} from workspace`}
            title="Remove from workspace — no files are deleted"
            onClick={onRemove}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {open && <div className="repo-body">{children}</div>}
    </section>
  );
}

function aheadBehind(status: WorkspaceStatus): string {
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`${status.ahead} commit${status.ahead === 1 ? '' : 's'} to push`);
  if (status.behind > 0) parts.push(`${status.behind} to pull`);
  return sentence(parts.join(', '));
}

/**
 * The workspace's own row, with everything you do to a workspace on it.
 *
 * VS Code draws this as `name (Workspace)` and hangs the folders beneath; the
 * shape is borrowed because it answers the question the dropdown could not —
 * *which folders are in here* — without making you open anything.
 */
function WorkspaceRow({
  workspace, others, folders, open, onToggle,
  onAddFolder, onSwitch, onCreate, onRename, onForget
}: {
  workspace: Workspace;
  others: Workspace[];
  folders: number;
  open: boolean;
  onToggle: () => void;
  onAddFolder: () => void;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (name: string) => void;
  onForget: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(workspace.name);

  // Any click outside closes the menu. Captured on the document rather than a
  // backdrop element so it does not sit over the rest of the explorer.
  useMenuDismiss(menu, () => setMenu(false));

  if (renaming) {
    return (
      <form
        className="ws-rename"
        onSubmit={(e) => { e.preventDefault(); onRename(draft); setRenaming(false); }}
      >
        <input
          autoFocus value={draft} aria-label="Workspace name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(workspace.name); setRenaming(false); } }}
        />
      </form>
    );
  }

  return (
    <div className="ws-row">
      <button className="ws-main" onClick={onToggle} aria-expanded={open}>
        <ChevronIcon open={open} size={11} />
        <span className="ws-title">{workspace.name}</span>
        <span className="ws-kind">(Workspace)</span>
        <span className="spacer" />
        <span className="ws-folders">{folders} folder{folders === 1 ? '' : 's'}</span>
      </button>
      <button
        className="icon-button" aria-label="Add a folder to this workspace"
        title="Add folder to workspace" onClick={onAddFolder}
      >
        <AddFolderIcon size={14} />
      </button>
      <div className="ws-menu-host">
        <button
          className="icon-button" aria-label="Workspace actions" aria-expanded={menu}
          onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
        >
          <MoreIcon />
        </button>
        {menu && (
          <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <button role="menuitem" onClick={() => { setMenu(false); onAddFolder(); }}>
              Add folder to workspace…
            </button>
            <button role="menuitem" onClick={() => { setMenu(false); setDraft(workspace.name); setRenaming(true); }}>
              Rename workspace
            </button>
            <div className="menu-rule" />
            {others.length > 0 && (
              <>
                <p className="menu-head">Switch to</p>
                {others.map((w) => (
                  <button key={w.id} role="menuitem" onClick={() => { setMenu(false); onSwitch(w.id); }}>
                    {w.name}
                    <span className="menu-note">{w.folders.length}</span>
                  </button>
                ))}
                <div className="menu-rule" />
              </>
            )}
            <button role="menuitem" onClick={() => { setMenu(false); onCreate(); }}>
              New workspace…
            </button>
            <button role="menuitem" onClick={() => { setMenu(false); void window.kovan.newWindow(); }}>
              New window
              <span className="menu-note">{isMac ? '⌘⇧N' : 'Ctrl+Shift+N'}</span>
            </button>
            {/* "Close", not "Delete": this forgets a list of folders and
                leaves every file where it is. */}
            <button role="menuitem" className="menu-warn" onClick={() => { setMenu(false); onForget(); }}>
              Close workspace
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One folder of the workspace.
 *
 * A folder that is itself a clone renders as the repository; a folder that
 * merely contains clones renders as itself with the clones under it. Either
 * way the row carries the remove button, because the folder is the thing that
 * was added and so the only thing that can be taken away.
 */
function RootRow({
  root, statuses, expanded, onToggle, onRemove, onTerminal, renderRepo, renderPlain, ...order
}: {
  root: Root;
  statuses: Record<string, WorkspaceStatus>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onRemove: () => void;
  onTerminal: (cwd: string) => void;
  renderRepo: (repo: WorkspaceRepo) => React.ReactNode;
  renderPlain: (folder: string) => React.ReactNode;
} & Reorderable) {
  const open = expanded.has(root.folder);
  const reorderable: Reorderable = { ...order, id: root.folder };

  if (root.repo) {
    return (
      <RepoRow
        repo={root.repo} status={statuses[root.repo.path]} open={open}
        onToggle={() => onToggle(root.folder)}
        onTerminal={() => onTerminal(root.repo!.path)}
        onRemove={onRemove}
        order={reorderable}
      >
        {renderRepo(root.repo)}
      </RepoRow>
    );
  }

  return (
    <section {...sectionProps(reorderable)}>
      <div className={open ? 'repo open' : 'repo'}>
        <button
          className="repo-main" onClick={() => onToggle(root.folder)} aria-expanded={open}
          title={`${root.folder}\nDrag, or ⌥↑ / ⌥↓, to reorder`}
          onKeyDown={moveKeys(reorderable)}
        >
          <ChevronIcon open={open} size={11} />
          <FolderIcon size={13} />
          <span className="repo-name">{root.name}</span>
          <span className="spacer" />
          {root.inside.length > 0 && (
            <span className="repo-pill quiet-pill">{root.inside.length} repos</span>
          )}
        </button>
        <button
          className="icon-button reveal" aria-label={`Open a terminal in ${root.name}`}
          title="Open a terminal here" onClick={() => onTerminal(root.folder)}
        >
          <TerminalIcon size={13} />
        </button>
        <button
          className="icon-button reveal remove" aria-label={`Remove ${root.name} from workspace`}
          title="Remove from workspace — no files are deleted" onClick={onRemove}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {open && (
        <div className="repo-body">
          {root.inside.length > 0
            ? root.inside.map((repo) => (
                <RepoRow
                  key={repo.path} repo={repo} status={statuses[repo.path]}
                  open={expanded.has(repo.path)} onToggle={() => onToggle(repo.path)}
                  onTerminal={() => onTerminal(repo.path)}
                >
                  {renderRepo(repo)}
                </RepoRow>
              ))
            : renderPlain(root.folder)}
        </div>
      )}
    </section>
  );
}

// --- Reordering the workspace's folders -----------------------------------------

/** What a top-level row needs to be dragged and moved from the keyboard. */
interface Reorderable {
  id?: string;
  /** This row is where the dragged one would land, before or after it. */
  drop?: 'before' | 'after';
  /** This row is the one being dragged. */
  dragging?: boolean;
  onDragStart: (event: React.PointerEvent) => void;
  onMove: (delta: -1 | 1) => void;
}

function sectionProps(order?: Reorderable) {
  if (!order) return { className: 'ws-root' };
  const classes = ['ws-root', 'reorderable'];
  if (order.drop) classes.push(`drop-${order.drop}`);
  if (order.dragging) classes.push('dragged');
  return {
    className: classes.join(' '),
    'data-root-row': order.id,
    onPointerDown: order.onDragStart
  };
}

/** ⌥↑ / ⌥↓ on the row's own button, as in the Sessions list. */
function moveKeys(order: Reorderable) {
  return (event: React.KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    order.onMove(event.key === 'ArrowUp' ? -1 : 1);
  };
}

/**
 * Dragging a row within a list, by rows marked with `attribute`.
 *
 * Window listeners, not pointer capture as in Sessions: capture retargets the
 * click to the element that captured it, so the row's own button (which
 * opens the repository) would stop getting clicks. Instead a press that moves
 * less than 4px stays a click, and once it has become a drag the click that
 * follows the release is swallowed, so a drop doesn't also open or shut the
 * row it started on.
 */
function useRowDrag(attribute: string, onDrop: (id: string, target: string, after: boolean) => void) {
  const [drop, setDrop] = useState<{ id: string; target: string; after: boolean }>();
  const latest = useRef(onDrop);
  latest.current = onDrop;

  const start = useCallback((id: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Terminal, remove and anything else inside keeps its own click.
    if (target.closest('.icon-button, input')) return;
    // Only the row's own head drags it: not the files open beneath it, and
    // not a repository nested inside a folder row.
    if (target.closest('.repo')?.parentElement !== event.currentTarget) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let dragging = false;
    let last: { id: string; target: string; after: boolean } | undefined;

    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add('dragging-row');
      }
      const row = document.elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>(`[${attribute}]`);
      const target = row?.getAttribute(attribute);
      if (row && target && target !== id) {
        const rect = row.getBoundingClientRect();
        last = { id, target, after: e.clientY > rect.top + rect.height / 2 };
      } else {
        last = undefined;
      }
      setDrop(last ?? { id, target: '', after: false });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('dragging-row');
      setDrop(undefined);
      if (!dragging) return;
      const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      // The click comes in the same task as the release, if at all — a
      // release outside the window has none, and this must not eat the next.
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (commit && last) latest.current(last.id, last.target, last.after);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, [attribute]);

  return { drop, start };
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

/**
 * What a revert button — one row's, or "Revert all" — is about to do,
 * pending the confirmation it always asks for first. A tracked change goes
 * back to HEAD; an untracked file has no HEAD version to go back to, so it
 * goes to the OS Trash instead — different enough consequences that the
 * confirmation names both counts rather than one blended one.
 */
interface PendingRevert {
  key: string;
  changes: FileChange[];
  tracked: number;
  untracked: number;
}

function describeRevert(changes: FileChange[]): PendingRevert {
  return {
    key: '',
    changes,
    tracked: changes.filter((c) => c.side !== 'untracked').length,
    untracked: changes.filter((c) => c.side === 'untracked').length
  };
}

/** Staged / Changes / Untracked, the grouping git itself uses. */
function ChangeList({
  repo, status, selected, onOpen, onRevert, busy
}: {
  repo: WorkspaceRepo;
  status?: WorkspaceStatus;
  selected?: string;
  onOpen: (repo: string, file: string, side: DiffSide, from?: string) => void;
  onRevert: (changes: FileChange[]) => void;
  busy: boolean;
}) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingRevert>();

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

  // Conflicts are not this button's job — resolving a merge is not the same
  // operation as discarding an edit, and running `git restore` on one would
  // just pick a side silently.
  const revertible = groups.flatMap((g) => g.rows).filter((c) => c.kind !== 'conflicted');

  const confirm = (changes: FileChange[], key: string) =>
    setPending({ ...describeRevert(changes), key });

  const run = () => {
    if (!pending) return;
    onRevert(pending.changes);
    setPending(undefined);
  };

  return (
    <>
      {groups.map((group, index) => {
        const open = !shut.has(group.id);
        return (
          <div key={group.id}>
            <div className="change-group-row">
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
              {/* Revert all sits in the first group's header, the way VS Code's
                  Source Control puts it, rather than on a line of its own. */}
              {index === 0 && revertible.length > 1 && (
                <div className="menu-host">
                  <button
                    type="button" className="icon-button revert revert-all" disabled={busy}
                    aria-label={`Revert all ${revertible.length} changes in ${repo.name}`}
                    title={`Revert all ${revertible.length} changes`}
                    onClick={(e) => { e.stopPropagation(); confirm(revertible, 'all'); }}
                  >
                    <RevertIcon />
                  </button>
                  {pending?.key === 'all' && (
                    <RevertConfirm pending={pending} busy={busy} onCancel={() => setPending(undefined)} onConfirm={run} />
                  )}
                </div>
              )}
            </div>
            {open && (
              <ul className="rows changes">
                {group.rows.map((change) => {
                  const id = `${repo.path}/${change.path}`;
                  const rowKey = `${change.side}:${change.path}`;
                  return (
                    <li key={rowKey} className="change-row">
                      <button
                        className={selected === id ? 'change selected' : 'change'}
                        onClick={() => onOpen(repo.path, change.path, change.side, change.from)}
                        title={change.from ? `${change.from} → ${change.path}` : change.path}
                      >
                        <span className={`change-mark ${change.kind}`}>{KIND_MARK[change.kind]}</span>
                        <span className="change-name">{baseOf(change.path)}</span>
                        <span className="change-dir"><bdi>{dirOf(change.path)}</bdi></span>
                      </button>
                      {change.kind !== 'conflicted' && (
                        <div className="menu-host">
                          <button
                            className="icon-button revert"
                            aria-label={
                              change.side === 'untracked'
                                ? `Move ${change.path} to Trash`
                                : `Discard changes to ${change.path}`
                            }
                            title={change.side === 'untracked' ? 'Move to Trash' : 'Discard this change'}
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); confirm([change], rowKey); }}
                          >
                            <RevertIcon />
                          </button>
                          {pending?.key === rowKey && (
                            <RevertConfirm
                              pending={pending} busy={busy}
                              onCancel={() => setPending(undefined)} onConfirm={run}
                            />
                          )}
                        </div>
                      )}
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

/**
 * The confirmation every revert button asks before it touches anything.
 *
 * Names exactly what is about to happen rather than a generic "are you
 * sure?" — a discard and a Trash are different enough consequences (one is
 * always recoverable from git, the other only from the Trash) that lumping
 * them into one sentence would hide which is which.
 */
function RevertConfirm({
  pending, busy, onCancel, onConfirm
}: {
  pending: PendingRevert;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Closes on a click outside, Escape, or another menu opening. The opening
  // click has to stop at its button: "Revert all" let it through, the
  // confirmation's own outside-click listener caught that same click, and it
  // closed as it opened, which is why Revert all never did anything.
  useMenuDismiss(true, onCancel);

  const parts: string[] = [];
  if (pending.tracked > 0) {
    parts.push(`discard ${pending.tracked} change${pending.tracked === 1 ? '' : 's'} back to the last commit`);
  }
  if (pending.untracked > 0) {
    parts.push(`move ${pending.untracked} untracked file${pending.untracked === 1 ? '' : 's'} to the Trash`);
  }

  return (
    <div className="menu confirm" role="menu" onClick={(e) => e.stopPropagation()}>
      <p>{sentence(parts.join(' and '))}?</p>
      <div className="confirm-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="menu-warn" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : 'Revert'}
        </button>
      </div>
    </div>
  );
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
        A workspace is a folder Kovan looks inside. It finds every git clone under it, so you
        can read — and edit — the code behind a ticket without leaving the app.
      </p>
      <button className="primary" onClick={onCreate}>Choose a folder</button>
    </div>
  );
}


// --- Tab bodies ---------------------------------------------------------------

/** Enough context lines to cover any file: the diff becomes one hunk. */
const WHOLE_FILE = 1_000_000;
const WHOLE_KEY = 'kovan.diff-whole-file';

function loadWhole(): boolean {
  try { return localStorage.getItem(WHOLE_KEY) === '1'; } catch { return false; }
}

function TabBody({
  tab, revision, repo, untracked, cursor, dirty, onDirty, onCursor, registerSave, onSave,
  onOpenFile, onStatus, goto
}: {
  tab: Tab;
  goto?: { line: number; nonce: number };
  /** Bumped whenever git status is re-read; see `WorkspaceView`. */
  revision: number;
  /** The clone the file is in — for a file tab, found by path; absent outside one. */
  repo?: string;
  untracked: boolean;
  cursor?: Cursor;
  dirty: boolean;
  onDirty: (value: boolean) => void;
  onCursor: (c: Cursor) => void;
  registerSave: (fn: (() => void) | undefined) => void;
  onSave: () => void;
  onOpenFile: (path: string) => void;
  /** Git state changed under us (a save, an empty diff); re-read the list. */
  onStatus: () => void;
}) {
  const [body, setBody] = useState<FileBody>();
  const [diff, setDiff] = useState<FileDiff>();
  const [marks, setMarks] = useState<ChangeMark[]>();
  const [error, setError] = useState<string>();
  /** Updated on every save, so the size shown is the size on disk. */
  const [bytes, setBytes] = useState<number>();
  const [saves, setSaves] = useState(0);
  // Remembered across tabs and launches: someone who reads diffs in full
  // wants the next one in full too.
  const [whole, setWhole] = useState(loadWhole);

  const toggleWhole = () => setWhole((w) => {
    try { localStorage.setItem(WHOLE_KEY, w ? '0' : '1'); } catch { /* this window only */ }
    return !w;
  });

  // The file's text is read once; after that the editor owns it and checks
  // the disk itself on every revision (see `Editor`).
  useEffect(() => {
    if (tab.kind !== 'file') return undefined;
    let cancelled = false;
    void window.kovan.workspaceRead(tab.path)
      .then((b) => { if (!cancelled) setBody(b); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tab]);

  // The diff, and a file's change bars, are read again on every revision and
  // after every save. The previous diff stays on screen until the new one
  // arrives, so a refresh doesn't flash a skeleton.
  useEffect(() => {
    let cancelled = false;
    if (tab.kind === 'diff') {
      void window.kovan
        .workspaceDiff(tab.repo!, tab.path, tab.side!, tab.from, whole ? WHOLE_FILE : undefined)
        .then((d) => {
          if (cancelled) return;
          setDiff(d);
          setError(undefined);
          // The list said this file had changes and git now says none: the
          // list is out of date, so bring it up to date too.
          if (d.empty) onStatus();
        })
        .catch((e: Error) => { if (!cancelled) setError(e.message); });
    } else if (repo) {
      const relative = tab.path.slice(repo.length + 1);
      void window.kovan
        .workspaceDiff(repo, relative, untracked ? 'untracked' : 'unstaged')
        .then((d) => { if (!cancelled) setMarks(changeMarks(d.hunks)); })
        // No bars is the honest answer when git can't say (an ignored file).
        .catch(() => { if (!cancelled) setMarks([]); });
    }
    return () => { cancelled = true; };
    // `onStatus` is a fresh closure every render; it is not a reason to re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, revision, whole, repo, untracked, saves]);

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
              path={tab.path} body={body} marks={marks} revision={revision}
              onDirtyChange={onDirty} onCursor={onCursor} registerSave={registerSave}
              {...(goto ? { goto } : {})}
              onSaved={(next) => {
                setBytes(next.bytes);
                // A save changes what git sees: new bars, and the list's count.
                setSaves((n) => n + 1);
                onStatus();
              }}
            />
            <div className="status-bar">
              {cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>}
              {cursor && cursor.selected > 0 && <span>Sel {cursor.selected}</span>}
              <span>{statusFor(tab.path)}</span>
              <span>{formatBytes(bytes ?? body.bytes)}</span>
              {marks && marks.length > 0 && (
                <span className="status-changes" title="Lines that differ from git's copy">
                  {describeMarks(marks)}
                </span>
              )}
              <span className="spacer" />
              {dirty ? (
                <button className="save" onClick={onSave}>Save <kbd>{keyLabel('S')}</kbd></button>
              ) : (
                <span className="saved">saved</span>
              )}
            </div>
          </>
        ) : <Skeleton rows={4} label="Reading…" />
      ) : diff ? (
        <Diff
          path={tab.path} side={tab.side!} from={tab.from} diff={diff}
          whole={whole} onWhole={toggleWhole}
          // Not for a binary, and not for a deleted file: nothing to open.
          onOpenFile={diff.binary || (!diff.empty && diff.hunks.every((h) => h.header.includes('+0,0')))
            ? undefined
            : () => onOpenFile(`${tab.repo}/${tab.path.replace(/\/$/, '')}`)}
        />
      ) : (
        <Skeleton rows={4} label="Diffing…" />
      )}
    </div>
  );
}

/** "3 changed · 1 added", for the status bar. */
function describeMarks(marks: ChangeMark[]): string {
  const count = (kind: ChangeMark['kind']) => marks.filter((m) => m.kind === kind).length;
  const parts: string[] = [];
  const modified = count('modified');
  const added = count('added');
  const deleted = count('deleted');
  if (modified) parts.push(`${modified} changed`);
  if (added) parts.push(`${added} added`);
  if (deleted) parts.push(`${deleted} removal${deleted === 1 ? '' : 's'}`);
  return parts.join(' · ');
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
