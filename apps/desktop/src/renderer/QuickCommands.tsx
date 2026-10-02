/**
 * Quick commands (improvements item 91), like Orca's: your own shell
 * commands — "frontend dev", "optimize", "run the tests" — saved with a name
 * and run from the title bar in one click, each in its own terminal session.
 *
 * The title bar has a split button: ▶ runs the one you ran last, ⌄ opens the
 * list — search, run, and on hover duplicate, edit or delete — with
 * "+ Command" at the bottom. A command that's already running (a dev server)
 * isn't started twice: running it again takes you to its session.
 *
 * Commands are stored and validated by main, and run by id — the page never
 * sends main a command line to execute.
 */

import { keyLabel } from './platform';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { filterQuickCommands, type QuickCommand } from '@kovan/core';
import { useMenuDismiss } from './menuDismiss';
import { ChevronIcon, CloseIcon, CopyIcon, EditIcon, PlayIcon, PlusIcon, SearchIcon, TrashIcon } from './icons';
import type { SessionInfo } from './types';

interface Draft { id?: string; name: string; command: string; cwd: string }

const EMPTY_DRAFT: Draft = { name: '', command: '', cwd: '' };

export function QuickCommands({ sessions, onRan }: {
  sessions: SessionInfo[];
  /** A command started (or was already running) in this session: show it. */
  onRan: (sessionId: string) => void;
}) {
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState<Draft>();
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const state = await window.kovan.commands();
    setCommands(state.commands);
    setLast(state.last);
    setBusy(state.busy);
    return state;
  }, []);
  // Sessions starting or ending, or the menu opening, is when "running" may
  // have changed; asked of main, which can see what's in the foreground.
  useEffect(() => { void reload(); }, [reload, sessions, open]);

  const close = useCallback(() => {
    setOpen(false);
    setDraft(undefined);
    setConfirming(undefined);
    setError(undefined);
    setQuery('');
  }, []);
  useMenuDismiss(open, close);

  useEffect(() => {
    if (open && !draft) requestAnimationFrame(() => search.current?.focus());
  }, [open, draft]);

  const shown = useMemo(() => filterQuickCommands(commands, query), [commands, query]);
  useEffect(() => setActive(0), [query]);
  const running = useMemo(() => new Set(busy), [busy]);
  const lastCommand = commands.find((c) => c.id === last);

  const run = useCallback(async (id: string) => {
    setError(undefined);
    const result = await window.kovan.commandRun(id);
    if (!result.ok) {
      setOpen(true);
      setError(result.error);
      return;
    }
    setLast(id);
    close();
    onRan(result.sessionId);
    // Give the command a moment to become the foreground process.
    setTimeout(() => void reload(), 1_200);
  }, [close, onRan]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await window.kovan.commandSave({ ...draft });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setDraft(undefined);
    await reload();
  };

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); void run(shown[active]!.id); }
  };

  return (
    <div className="menu-host quick-commands">
      <div className="qc-split">
        <button
          type="button"
          className="qc-run"
          title={lastCommand ? `Run “${lastCommand.name}”\n${lastCommand.command}` : 'Quick commands: save a command to run in one click'}
          onClick={(e) => {
            e.stopPropagation();
            if (lastCommand) void run(lastCommand.id);
            else { setOpen(true); setDraft({ ...EMPTY_DRAFT }); }
          }}
        >
          <PlayIcon size={10} />
          <span className="qc-run-name">{lastCommand?.name ?? 'Quick commands'}</span>
          {lastCommand && running.has(lastCommand.id) && <span className="dot live" title="Running" />}
        </button>
        <button
          type="button"
          className="qc-toggle"
          aria-label="All quick commands"
          aria-expanded={open}
          title="All quick commands"
          onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        >
          <ChevronIcon size={11} open />
        </button>
      </div>

      {open && (
        <div className="menu qc-menu" role="dialog" aria-label="Quick commands" onClick={(e) => e.stopPropagation()}>
          {draft ? (
            <form
              className="qc-editor"
              onSubmit={(e) => { e.preventDefault(); void save(); }}
            >
              <div className="qc-editor-head">
                <strong>{draft.id ? 'Edit command' : 'New command'}</strong>
                <span className="spacer" />
                <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={close}>
                  <CloseIcon size={12} />
                </button>
              </div>
              <label>
                <span>Name</span>
                <input
                  autoFocus value={draft.name} placeholder="frontend dev" maxLength={60}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                <span>Command</span>
                <textarea
                  value={draft.command} rows={3} spellCheck={false}
                  placeholder="cd ~/code/app/frontend && npm run dev"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
                />
              </label>
              <label>
                <span>Run in <em>— empty means your home folder</em></span>
                <span className="qc-folder">
                  <input
                    value={draft.cwd} placeholder="~" spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  />
                  <button
                    type="button" className="ghost"
                    onClick={() => void window.kovan.commandFolder().then((p) => p && setDraft((d) => d && { ...d, cwd: p }))}
                  >
                    Choose…
                  </button>
                </span>
              </label>
              {error && <p className="qc-error">{error}</p>}
              <div className="qc-editor-actions">
                <button type="submit" className="ghost" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                <button type="button" className="link" onClick={() => { setDraft(undefined); setError(undefined); }}>Cancel</button>
                <span className="spacer" />
                <span className="qc-hint">{keyLabel('↩')} saves</span>
              </div>
            </form>
          ) : (
            <>
              <div className="qc-search">
                <SearchIcon />
                <input
                  ref={search} value={query} placeholder="Search quick commands…" aria-label="Search quick commands"
                  onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
                />
                <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={close}>
                  <CloseIcon size={12} />
                </button>
              </div>
              {error && <p className="qc-error">{error}</p>}
              {commands.length === 0 ? (
                <p className="qc-empty">
                  Save a command you run often — a dev server, a test run, a build — and run it from here in one click,
                  in its own terminal.
                </p>
              ) : shown.length === 0 ? (
                <p className="qc-empty">No command matches.</p>
              ) : (
                <ul className="qc-list" role="listbox" aria-label="Commands">
                  {shown.map((c, i) => (
                    <li key={c.id}>
                      {confirming === c.id ? (
                        <div className="qc-confirm">
                          <span>Delete “{c.name}”?</span>
                          <span className="spacer" />
                          <button
                            type="button" className="ghost qc-delete"
                            onClick={() => void window.kovan.commandDelete(c.id).then(reload).then(() => setConfirming(undefined))}
                          >
                            Delete
                          </button>
                          <button type="button" className="link" onClick={() => setConfirming(undefined)}>Cancel</button>
                        </div>
                      ) : (
                        <div
                          className={i === active ? 'qc-row active' : 'qc-row'}
                          role="option" aria-selected={i === active}
                          onMouseEnter={() => setActive(i)}
                        >
                          <button type="button" className="qc-row-run" onClick={() => void run(c.id)}
                            title={running.has(c.id) ? 'Running — go to its terminal' : `Run in ${c.cwd || '~'}`}
                          >
                            <span className="qc-row-play"><PlayIcon size={9} /></span>
                            <span className="qc-row-text">
                              <span className="qc-row-name">
                                {c.name}
                                {running.has(c.id) && <span className="state"><span className="dot live" />running</span>}
                              </span>
                              <span className="qc-row-command">{c.command}</span>
                            </span>
                          </button>
                          <span className="qc-row-actions">
                            <button type="button" className="icon-button" aria-label={`Duplicate ${c.name}`} title="Duplicate"
                              onClick={() => void window.kovan.commandDuplicate(c.id).then(reload)}>
                              <CopyIcon size={13} />
                            </button>
                            <button type="button" className="icon-button" aria-label={`Edit ${c.name}`} title="Edit"
                              onClick={() => { setError(undefined); setDraft({ id: c.id, name: c.name, command: c.command, cwd: c.cwd }); }}>
                              <EditIcon size={13} />
                            </button>
                            <button type="button" className="icon-button" aria-label={`Delete ${c.name}`} title="Delete"
                              onClick={() => setConfirming(c.id)}>
                              <TrashIcon size={13} />
                            </button>
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="qc-add" onClick={() => { setError(undefined); setDraft({ ...EMPTY_DRAFT }); }}>
                <PlusIcon size={12} /> Command
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
