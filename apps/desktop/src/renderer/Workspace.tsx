/**
 * The workspace: folders you picked, the clones found inside them, their
 * files, and what has changed.
 *
 * Shaped after VS Code because that is the shape people already know — an
 * explorer on the left, tabs across the editor, source control alongside the
 * files. What is *not* borrowed is the behaviour underneath: nothing here
 * edits, nothing watches the filesystem, and every directory is listed only
 * when it is opened. A workspace pointed at a folder full of `node_modules`
 * has to stay as cheap to open as one pointed at an empty directory.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code } from './Code';
import { Diff } from './Diff';
import {
  ChangesIcon, ChevronIcon, CloseIcon, FileIcon, FolderIcon, PlusIcon, RefreshIcon, TerminalIcon
} from './icons';
import type {
  ChangeKind, DiffSide, Entry, FileBody, FileDiff, Workspace, WorkspaceRepo, WorkspaceStatus
} from './types';

/** A tab is either a file being read or a change being reviewed. */
interface Tab {
  /** Identity, and what makes re-opening the same thing focus rather than duplicate. */
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
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  conflicted: '!',
  untracked: 'U'
};

export function WorkspaceView({ onTerminal }: { onTerminal: (cwd: string) => void }) {
  const [list, setList] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string>();
  const [repos, setRepos] = useState<WorkspaceRepo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const [busy, setBusy] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [current, setCurrent] = useState<string>();

  const workspace = list.find((w) => w.id === active);

  const loadWorkspaces = useCallback(async () => {
    const { list: all, active: id } = await window.baton.workspaces();
    setList(all);
    setActive((previous) => (previous && all.some((w) => w.id === previous) ? previous : id));
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  /**
   * Repos and statuses for the active workspace.
   *
   * `cancelled` matters here: switching workspaces twice quickly would
   * otherwise let the first scan resolve last and paint the wrong folder's
   * repositories — the same late-resolve race the snapshot subscription has.
   */
  const loadRepos = useCallback(
    async (id: string, force = false) => {
      setBusy(true);
      try {
        const found = await window.baton.workspaceRepos(id, force);
        setRepos(found);
        const entries = await Promise.all(
          found.map(async (repo) => [repo.path, await window.baton.workspaceStatus(repo.path)] as const)
        );
        setStatuses(Object.fromEntries(entries));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!active) {
      setRepos([]);
      setStatuses({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const found = await window.baton.workspaceRepos(active);
      if (cancelled) return;
      setRepos(found);
      const entries = await Promise.all(
        found.map(async (repo) => [repo.path, await window.baton.workspaceStatus(repo.path)] as const)
      );
      if (!cancelled) setStatuses(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

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

  const open = useCallback((tab: Tab) => {
    setTabs((existing) => (existing.some((t) => t.key === tab.key) ? existing : [...existing, tab]));
    setCurrent(tab.key);
  }, []);

  const openFile = useCallback(
    (entry: Entry) => open({ key: `file:${entry.path}`, kind: 'file', title: entry.name, path: entry.path }),
    [open]
  );

  const openDiff = useCallback(
    (repo: string, file: string, side: DiffSide, from?: string) =>
      open({
        // The side is part of the identity: the staged and unstaged diffs of
        // one file are two different things and must be two tabs.
        key: `diff:${side}:${repo}/${file}`,
        kind: 'diff',
        title: file.split('/').pop() ?? file,
        path: file,
        repo,
        side,
        ...(from ? { from } : {})
      }),
    [open]
  );

  const close = useCallback((key: string) => {
    setTabs((existing) => {
      const index = existing.findIndex((t) => t.key === key);
      const next = existing.filter((t) => t.key !== key);
      setCurrent((active_) => {
        if (active_ !== key) return active_;
        // Focus the neighbour, preferring the one on the left — closing the
        // last tab should land on the new last tab, not on nothing.
        return next[Math.min(index, next.length - 1)]?.key;
      });
      return next;
    });
  }, []);

  const tab = tabs.find((t) => t.key === current);

  return (
    <>
      <aside className="queue explorer" aria-label="Explorer">
        <div className="queue-head">
          <div className="queue-title-row">
            <h1>Workspace</h1>
            <button
              type="button" className="icon-button" aria-label="Refresh workspace"
              disabled={!active || busy}
              onClick={() => active && void loadRepos(active, true)}
            >
              <RefreshIcon size={14} />
            </button>
            <button
              type="button" className="icon-button" aria-label="New workspace"
              onClick={() =>
                void window.baton.workspaceCreate().then(async (made) => {
                  if (!made) return;
                  await loadWorkspaces();
                  setActive(made.id);
                })
              }
            >
              <PlusIcon />
            </button>
          </div>

          {list.length > 0 && (
            <div className="ws-picker">
              <select
                aria-label="Active workspace"
                value={active ?? ''}
                onChange={(e) => {
                  setActive(e.target.value);
                  void window.baton.workspaceActivate(e.target.value);
                }}
              >
                {list.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <button
                type="button" className="icon-button" aria-label="Add a folder"
                onClick={() =>
                  active &&
                  void window.baton.workspaceAddFolder(active).then(async (updated) => {
                    if (updated) {
                      await loadWorkspaces();
                      await loadRepos(active, true);
                    }
                  })
                }
              >
                <PlusIcon size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="queue-list">
          {!workspace ? (
            <NoWorkspace
              onCreate={() =>
                void window.baton.workspaceCreate().then(async (made) => {
                  if (!made) return;
                  await loadWorkspaces();
                  setActive(made.id);
                })
              }
            />
          ) : (
            <Roots
              workspace={workspace}
              repos={repos}
              statuses={statuses}
              changed={changed}
              busy={busy}
              onOpenFile={openFile}
              onOpenDiff={openDiff}
              onTerminal={onTerminal}
            />
          )}
        </div>
      </aside>

      <main className="pane editor-pane">
        {tabs.length === 0 ? (
          <p className="quiet centred">
            {workspace
              ? 'Pick a file to read it, or a change to see the diff.'
              : 'Create a workspace to browse your repositories.'}
          </p>
        ) : (
          <>
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <div
                  key={t.key}
                  role="tab"
                  aria-selected={t.key === current}
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
                  <button className="tab-close" aria-label={`Close ${t.title}`} onClick={() => close(t.key)}>
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
            {tab && <TabBody tab={tab} />}
          </>
        )}
      </main>
    </>
  );
}

function NoWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="ws-empty">
      <p className="quiet">
        A workspace is a folder Baton looks inside. It finds the git clones under it, so you can
        read the code behind a ticket without leaving the app.
      </p>
      <button className="primary" onClick={onCreate}>Choose a folder</button>
    </div>
  );
}

// --- The explorer tree --------------------------------------------------------

function Roots({
  workspace, repos, statuses, changed, busy, onOpenFile, onOpenDiff, onTerminal
}: {
  workspace: Workspace;
  repos: WorkspaceRepo[];
  statuses: Record<string, WorkspaceStatus>;
  changed: Map<string, ChangeKind>;
  busy: boolean;
  onOpenFile: (entry: Entry) => void;
  onOpenDiff: (repo: string, file: string, side: DiffSide, from?: string) => void;
  onTerminal: (cwd: string) => void;
}) {
  /**
   * Folders that hold no clone are shown as themselves.
   *
   * Without this, picking a folder that is not a repository and contains none
   * would show an empty explorer — technically "no repositories found", but
   * indistinguishable from a broken scan.
   */
  const plain = workspace.folders.filter(
    (folder) => !repos.some((r) => r.path === folder || r.path.startsWith(folder + '/'))
  );

  if (repos.length === 0 && plain.length === 0) {
    return <p className="quiet">{busy ? 'Scanning…' : 'No folders in this workspace.'}</p>;
  }

  return (
    <>
      {repos.map((repo) => (
        <RepoSection
          key={repo.path}
          repo={repo}
          status={statuses[repo.path]}
          changed={changed}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onTerminal={onTerminal}
        />
      ))}
      {plain.map((folder) => (
        <section className="ws-root" key={folder}>
          <div className="ws-head">
            <span className="ws-name">{folder.split('/').pop()}</span>
            <span className="spacer" />
            <button
              className="icon-button" aria-label="Open a terminal here"
              onClick={() => onTerminal(folder)}
            >
              <TerminalIcon size={13} />
            </button>
          </div>
          <Tree dir={folder} depth={0} changed={changed} onOpenFile={onOpenFile} />
        </section>
      ))}
    </>
  );
}

function RepoSection({
  repo, status, changed, onOpenFile, onOpenDiff, onTerminal
}: {
  repo: WorkspaceRepo;
  status?: WorkspaceStatus;
  changed: Map<string, ChangeKind>;
  onOpenFile: (entry: Entry) => void;
  onOpenDiff: (repo: string, file: string, side: DiffSide, from?: string) => void;
  onTerminal: (cwd: string) => void;
}) {
  const [showFiles, setShowFiles] = useState(true);
  const [showChanges, setShowChanges] = useState(true);
  const count = status?.changes ?? 0;

  // Staged first, because that is the order they will be committed in.
  const rows = [
    ...(status?.staged ?? []),
    ...(status?.unstaged ?? []),
    ...(status?.untracked ?? [])
  ];

  return (
    <section className="ws-root">
      <div className="ws-head">
        <span className="ws-name">{repo.name}</span>
        {repo.branch && <span className="ws-branch">{repo.branch}</span>}
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="ws-ab">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-button" aria-label={`Open a terminal in ${repo.name}`}
          onClick={() => onTerminal(repo.path)}
        >
          <TerminalIcon size={13} />
        </button>
      </div>

      <button className="ws-section" onClick={() => setShowChanges((v) => !v)}>
        <ChevronIcon open={showChanges} />
        <ChangesIcon size={12} />
        <span>Changes</span>
        {count > 0 && <span className="ws-count">{count}</span>}
      </button>
      {showChanges &&
        (rows.length === 0 ? (
          <p className="ws-clean">{status ? 'No changes' : 'Reading…'}</p>
        ) : (
          <ul className="rows changes">
            {rows.map((change) => (
              <li key={`${change.side}:${change.path}`}>
                <button
                  className="change"
                  onClick={() => onOpenDiff(repo.path, change.path, change.side, change.from)}
                  title={change.from ? `${change.from} → ${change.path}` : change.path}
                >
                  <span className={`change-mark ${change.kind}`}>{KIND_MARK[change.kind]}</span>
                  <span className="change-name">{baseOf(change.path)}</span>
                  <span className="change-dir"><bdi>{dirOf(change.path)}</bdi></span>
                  {change.side === 'staged' && <span className="change-staged">staged</span>}
                </button>
              </li>
            ))}
          </ul>
        ))}

      <button className="ws-section" onClick={() => setShowFiles((v) => !v)}>
        <ChevronIcon open={showFiles} />
        <FolderIcon size={12} />
        <span>Files</span>
      </button>
      {showFiles && <Tree dir={repo.path} depth={0} changed={changed} onOpenFile={onOpenFile} />}
    </section>
  );
}

/**
 * One directory level, which loads its own children when opened.
 *
 * Recursion happens through the component tree rather than through a
 * pre-walked data structure, so an unopened directory costs exactly one row
 * and no filesystem call.
 */
function Tree({
  dir, depth, changed, onOpenFile
}: {
  dir: string;
  depth: number;
  changed: Map<string, ChangeKind>;
  onOpenFile: (entry: Entry) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void window.baton
      .workspaceTree(dir)
      .then((list) => !cancelled && setEntries(list))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [dir]);

  if (error) return <p className="ws-clean">{error}</p>;
  if (!entries) return <p className="ws-clean">Reading…</p>;
  if (entries.length === 0) return <p className="ws-clean">Empty</p>;

  return (
    <ul className="tree">
      {entries.map((entry) => {
        const isOpen = open.has(entry.path);
        const mark = changed.get(entry.path);
        return (
          <li key={entry.path}>
            <button
              className={mark ? `tree-row changed ${mark}` : 'tree-row'}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => {
                if (!entry.directory) {
                  onOpenFile(entry);
                  return;
                }
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              }}
            >
              {entry.directory ? (
                <>
                  <ChevronIcon open={isOpen} size={11} />
                  <FolderIcon size={13} />
                </>
              ) : (
                <>
                  <span className="tree-spacer" />
                  <FileIcon size={13} />
                </>
              )}
              <span className="tree-name">{entry.name}</span>
            </button>
            {entry.directory && isOpen && (
              <Tree dir={entry.path} depth={depth + 1} changed={changed} onOpenFile={onOpenFile} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --- Tab bodies ---------------------------------------------------------------

function TabBody({ tab }: { tab: Tab }) {
  const [body, setBody] = useState<FileBody>();
  const [diff, setDiff] = useState<FileDiff>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setBody(undefined);
    setDiff(undefined);
    setError(undefined);

    const load =
      tab.kind === 'file'
        ? window.baton.workspaceRead(tab.path).then((b) => !cancelled && setBody(b))
        : window.baton
            .workspaceDiff(tab.repo!, tab.path, tab.side!, tab.from)
            .then((d) => !cancelled && setDiff(d));

    void load.catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [tab]);

  if (error) return <p className="quiet centred error">{error}</p>;

  return (
    <div className="tab-body">
      <div className="tab-path">
        <bdi>{tab.kind === 'file' ? tab.path : `${tab.repo}/${tab.path}`}</bdi>
      </div>
      {tab.kind === 'file' ? (
        body ? <Code path={tab.path} body={body} /> : <p className="quiet centred">Reading…</p>
      ) : diff ? (
        <Diff path={tab.path} side={tab.side!} from={tab.from} diff={diff} />
      ) : (
        <p className="quiet centred">Diffing…</p>
      )}
    </div>
  );
}

/**
 * Git reports an untracked *directory* with a trailing slash. Splitting that on
 * "/" yields an empty last segment, which rendered as a change row with no
 * name at all — so the slash comes off first, and goes back on the label to
 * say what it is.
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
