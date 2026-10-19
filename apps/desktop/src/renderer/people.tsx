/**
 * Someone else's pull requests or tickets (item 164): the person button
 * beside a list's title, and the fetch behind the person it picks.
 *
 * Nothing here runs on its own. The people are asked the first time the menu
 * opens; a person's list when they are picked, and again with each refresh
 * while they stay picked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Teammate } from '@kovan/core';
import { CheckIcon, ChevronIcon, SearchIcon } from './icons';
import { useMenuDismiss } from './menuDismiss';

/** "Lena Della Cagna" → "LD"; "dave-dev" → "MV". */
export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? '?') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

/** "Lena Della Cagna" → "Lena", for "Lena's tickets". */
export function firstName(person: Teammate): string {
  return person.name.split(/\s+/)[0] || person.name;
}

/** Initials on a neutral disc: no colour, since colour here means state or selection. */
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return <span className={small ? 'person-avatar small' : 'person-avatar'} aria-hidden="true">{initials(name)}</span>;
}

export function PersonPicker({
  service, value, onChange, me
}: {
  service: 'github' | 'jira';
  /** Undefined is you. */
  value: Teammate | undefined;
  onChange: (person: Teammate | undefined) => void;
  /** Your own name for the avatar ("idrisay"). */
  me: string;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Teammate[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useMenuDismiss(open, () => setOpen(false));

  const load = useCallback(() => {
    setError(undefined);
    window.kovan.teammates(service).then(setPeople, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [service]);

  useEffect(() => {
    if (!open) return;
    if (!people) load();
    setQuery('');
    search.current?.focus();
    // Only on opening: the list is kept for the window's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.handle ?? '').toLowerCase().includes(q));
  }, [people, query]);

  const pick = (person: Teammate | undefined) => {
    onChange(person);
    setOpen(false);
  };
  const what = service === 'github' ? 'open pull requests' : 'open tickets';

  return (
    <div className="menu-host person-host">
      <button
        type="button"
        className={value ? 'person-button other' : 'person-button'}
        aria-label={`Whose ${service === 'github' ? 'pull requests' : 'tickets'}: ${value ? value.name : 'yours'}`}
        aria-expanded={open}
        title={value ? `Showing ${value.name}'s. Esc goes back to yours.` : 'Show a teammate\'s'}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {value ? <Avatar name={value.name} small /> : <Avatar name={me || 'You'} small />}
        <span className="person-button-name">{value ? firstName(value) : 'You'}</span>
        <ChevronIcon size={10} open />
      </button>
      {open && (
        <div className="menu person-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="search person-search">
            <SearchIcon />
            <input
              ref={search} type="text" placeholder="Find a teammate" aria-label="Find a teammate"
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && shown[0]) pick(shown[0]);
              }}
            />
          </div>
          <button type="button" role="menuitemradio" aria-checked={!value} className={!value ? 'active' : ''} onClick={() => pick(undefined)}>
            <Avatar name={me || 'You'} />
            <span className="person-name">You</span>
            {me && service === 'github' && <span className="person-handle">{me}</span>}
            {!value && <span className="person-check"><CheckIcon size={12} /></span>}
          </button>
          <p className="menu-head">Team</p>
          {error ? (
            <p className="menu-empty">
              Couldn't load your team: {error}{' '}
              <button type="button" className="link" onClick={load}>Retry</button>
            </p>
          ) : !people ? (
            <p className="menu-empty">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="menu-empty">{query ? 'No one matches.' : 'No one else found yet.'}</p>
          ) : (
            <div className="person-list">
              {shown.map((p) => (
                <button
                  key={p.id} type="button" role="menuitemradio" aria-checked={value?.id === p.id}
                  className={value?.id === p.id ? 'active' : ''}
                  title={`${p.open} ${what}`}
                  onClick={() => pick(p)}
                >
                  <Avatar name={p.name} />
                  <span className="person-name">{p.name}</span>
                  {p.handle && p.handle !== p.name && <span className="person-handle">{p.handle}</span>}
                  <span className={p.open > 0 ? 'person-count' : 'person-count none'}>{p.open}</span>
                </button>
              ))}
            </div>
          )}
          <p className="person-foot">
            {service === 'github'
              ? 'Everyone with a pull request in your repositories. The number is their open ones.'
              : 'Everyone with a ticket in your projects in the last 90 days. The number is their open ones.'}
          </p>
        </div>
      )}
    </div>
  );
}

export interface PersonData<T> {
  data?: T;
  loading: boolean;
  error?: string;
  retry: () => void;
}

/**
 * The picked person's list. Asked when they are picked and again whenever
 * `refreshKey` moves (each poll of your own lists), so theirs is as fresh as
 * yours. A different person drops the old answer at once: someone else's rows
 * must never sit under a new name.
 */
export function usePersonData<T>(
  personId: string | undefined, load: (id: string) => Promise<T>, refreshKey: unknown
): PersonData<T> {
  const [state, setState] = useState<{ id?: string; data?: T; error?: string; loading: boolean }>({ loading: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!personId) {
      setState({ loading: false });
      return undefined;
    }
    let live = true;
    setState((s) => (s.id === personId ? { ...s, loading: true } : { id: personId, loading: true }));
    load(personId).then(
      (data) => { if (live) setState({ id: personId, data, loading: false }); },
      (err: unknown) => {
        if (live) setState((s) => ({ ...s, id: personId, loading: false, error: err instanceof Error ? err.message : String(err) }));
      }
    );
    return () => { live = false; };
  }, [personId, load, refreshKey, attempt]);
  return {
    ...(state.id === personId && state.data !== undefined ? { data: state.data } : {}),
    loading: state.loading,
    ...(state.id === personId && state.error ? { error: state.error } : {}),
    retry: () => setAttempt((n) => n + 1)
  };
}
