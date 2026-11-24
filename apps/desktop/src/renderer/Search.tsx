/**
 * Search everything, in the middle of the title bar (item 127).
 *
 * One box for pull requests, tickets, Sentry issues, sessions, files and the
 * app's own actions, like VS Code's command center. ⌘K or a click opens it in
 * place; results are grouped and keep their status; ⇥ narrows to one kind
 * and `>` searches actions only. With nothing typed it shows what is blocked
 * on you, what is running and the files you opened last.
 *
 * It searches only what is already loaded (see `searchEverything.ts`). The
 * file list is the one ⌘P uses, asked for when the box opens.
 */
import { isAppShortcut, keyLabel } from './platform';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JiraIssue, PullSummary, SentryIssue } from '@kovan/core';
import { SCOPES, nextScope, search, type Candidate, type Hit, type ScopeId } from './searchEverything';
import { recentFiles, rememberFile } from './QuickOpen';
import { States, repoName } from './rows';
import { SearchIcon } from './icons';
import type { SessionInfo, Snapshot } from './types';

export interface SearchAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Data =
  | { pull: PullSummary }
  | { issue: JiraIssue }
  | { sentry: SentryIssue }
  | { session: SessionInfo }
  | { file: string }
  | { action: SearchAction };

/** The group headings, with nothing typed. */
const EMPTY_GROUPS: Record<string, string> = {
  pull: 'Blocked on you and awaiting your review',
  session: 'Sessions',
  file: 'Recent files',
  action: 'Actions'
};

export function Search({ snapshot, sessions, actions, onPull, onIssue, onSentry, onSession, onFile }: {
  snapshot: Snapshot;
  sessions: SessionInfo[];
  actions: SearchAction[];
  onPull: (pull: PullSummary) => void;
  onIssue: (issue: JiraIssue) => void;
  onSentry: (issue: SentryIssue) => void;
  onSession: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeId>('all');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<{ path: string; rel: string }[]>();
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setScope('all');
    input.current?.blur();
  }, []);

  // ⌘K from anywhere — captured, so a focused terminal can't take it first.
  // On Linux it's Ctrl+K, and a terminal keeps that one (see platform.ts).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isAppShortcut(event) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // The file list, each time it opens (main keeps it cached).
  useEffect(() => {
    if (!open) return;
    void window.kovan.quickOpenFiles().then((answer) => setFiles(answer.files));
  }, [open]);

  const typed = query.trim().length > 0 && query.trim() !== '>';

  const candidates = useMemo(() => {
    const out: Candidate<Data>[] = [];
    const seen = new Set<string>();
    const pulls = typed || scope !== 'all'
      ? [...snapshot.blocked, ...snapshot.reviewRequested, ...snapshot.mine, ...snapshot.merged]
      : [...snapshot.blocked, ...snapshot.reviewRequested];
    for (const pull of pulls) {
      // By repo and number, as the list does: one pull request can be in
      // several of these lists.
      const id = `${pull.repo}#${pull.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        kind: 'pull', id, key: `${repoName(pull.repo)} #${pull.number}`, title: pull.title,
        extra: `${pull.repo} ${pull.number} ${pull.headRef ?? ''} ${pull.author}`,
        penalty: pull.mergedAt ? 2 : 0, data: { pull }
      });
    }
    for (const issue of snapshot.tickets) {
      out.push({ kind: 'ticket', id: issue.key, key: issue.key, title: issue.summary, extra: `${issue.status} ${issue.issueType}`, data: { issue } });
    }
    for (const issue of snapshot.sentryIssues) {
      out.push({ kind: 'sentry', id: issue.id, key: issue.shortId, title: issue.title, extra: `${issue.culprit} ${issue.project}`, data: { sentry: issue } });
    }
    const shownSessions = typed || scope !== 'all' ? sessions : sessions.filter((s) => s.running);
    for (const session of shownSessions) {
      out.push({ kind: 'session', id: session.id, key: session.runnerName === 'Shell' ? 'terminal' : session.runnerName, title: session.task ?? session.title, extra: `${session.title} ${session.subject ?? ''} ${session.cwd}`, data: { session } });
    }
    const fileList = typed ? files ?? [] : recentFiles().map((path) => ({ path, rel: files?.find((f) => f.path === path)?.rel ?? path.split('/').slice(-3).join('/') }));
    for (const f of fileList) {
      out.push({ kind: 'file', id: f.path, key: tagOf(f.rel), title: f.rel, data: { file: f.path } });
    }
    for (const action of actions) {
      out.push({ kind: 'action', id: action.id, key: 'action', title: action.label, extra: action.hint, data: { action } });
    }
    return out;
  }, [snapshot, sessions, files, actions, typed, scope]);

  const { scope: effective, hits } = useMemo(() => {
    // With nothing typed and no scope, tickets and Sentry wait for a query:
    // the empty box is about what needs you now.
    // Of the actions, only handing what's open now to an agent.
    const pool = !typed && scope === 'all'
      ? candidates.filter((c) => c.kind !== 'ticket' && c.kind !== 'sentry' && (c.kind !== 'action' || c.id.endsWith('-open')))
      : candidates;
    return search(query, scope, pool, scope === 'all' && !query.trimStart().startsWith('>') ? (typed ? 4 : 5) : 50);
  }, [query, scope, candidates, typed]);

  useEffect(() => { setActive(0); }, [query, scope]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (hit: Hit<Data> | undefined) => {
    if (!hit) return;
    const d = hit.candidate.data;
    close();
    if ('pull' in d) onPull(d.pull);
    else if ('issue' in d) onIssue(d.issue);
    else if ('sentry' in d) onSentry(d.sentry);
    else if ('session' in d) onSession(d.session.id);
    else if ('file' in d) { rememberFile(d.file); onFile(d.file); }
    else d.action.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(hits[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); setScope((s) => nextScope(s, e.shiftKey)); }
  };

  // One flat index across the groups, for the keyboard.
  let index = -1;
  const groups: ReactNode[] = [];
  for (const { id, group } of SCOPES) {
    if (id === 'all') continue;
    const mine = hits.filter((h) => h.candidate.kind === id);
    if (mine.length === 0) continue;
    groups.push(
      <div key={id} role="group" aria-label={group}>
        <p className="tsearch-group">{!typed && scope === 'all' ? EMPTY_GROUPS[id] ?? group : group}</p>
        {mine.map((hit) => {
          index += 1;
          const i = index;
          return (
            <button
              key={`${id}:${hit.candidate.id}`} type="button" role="option" aria-selected={i === active}
              className={i === active ? 'tsearch-row active' : 'tsearch-row'}
              onMouseMove={() => setActive(i)} onClick={() => choose(hit)}
            >
              <span className="tsearch-key">{hit.candidate.key}</span>
              <span className="tsearch-title"><Marked text={hit.candidate.title} marks={hit.marks} /></span>
              <span className="tsearch-meta"><Meta data={hit.candidate.data} /></span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={open ? 'tsearch open' : 'tsearch'} ref={host}>
      <label className="tsearch-box">
        <SearchIcon />
        <input
          ref={input} value={query} spellCheck={false}
          placeholder={open ? placeholderFor(effective) : 'Search pull requests, tickets, sessions, files…'}
          aria-label="Search everything" aria-expanded={open} aria-controls="search-results" role="combobox"
          onFocus={() => setOpen(true)} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onKeyDown={onKey}
        />
        {!open && <kbd>{keyLabel('K')}</kbd>}
      </label>
      {open && (
        <div className="tsearch-drop" id="search-results">
          <div className="tsearch-scopes" role="tablist" aria-label="Search in">
            {SCOPES.map((s) => (
              <button
                key={s.id} type="button" role="tab" aria-selected={effective === s.id}
                className={effective === s.id ? 'tsearch-scope on' : 'tsearch-scope'}
                onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(s.id)}
              >{s.label}</button>
            ))}
          </div>
          <div className="tsearch-list" ref={list} role="listbox" aria-label="Results">
            {groups.length > 0 ? groups : (
              <p className="tsearch-empty">{typed ? `Nothing loaded matches “${query.trim()}”.` : 'Nothing here yet.'}</p>
            )}
          </div>
          <div className="tsearch-foot"><span>↑↓ move</span><span>⏎ open</span><span>⇥ next scope</span><span>&gt; actions only</span><span>esc close</span></div>
        </div>
      )}
    </div>
  );
}

function placeholderFor(scope: ScopeId): string {
  return scope === 'all' ? 'Search everything, or > for actions' : `Search ${SCOPES.find((s) => s.id === scope)!.label.toLowerCase()}`;
}

function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  if (marks.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start < at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Meta({ data }: { data: Data }) {
  if ('pull' in data) return data.pull.mergedAt ? <span className="state">Merged</span> : <States pull={data.pull} max={1} />;
  if ('issue' in data) return <>{data.issue.status}</>;
  if ('sentry' in data) return <>{data.sentry.count} events</>;
  if ('session' in data) return <>{data.session.running ? (data.session.status === 'input' ? 'needs input' : 'running') : 'exited'}</>;
  if ('file' in data) return null;
  return <>{data.action.hint ?? ''}</>;
}

function tagOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return ext ? ext.slice(0, 4) : 'file';
}
