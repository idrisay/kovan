/**
 * Pinning (item 145, option C "pin in place"): a pinned pull request, ticket
 * or session keeps its place in its list and gets a pin by its age. Nothing
 * moves. What a pin adds is that the row no longer drops out: a pull request
 * that ages out of the merged window, or a ticket reassigned or moved to
 * Done, is fetched once and kept in the list. The pin in a list's header
 * shows only what is pinned.
 *
 * Pins are a setting, not a localStorage preference: they are things the
 * user chose to keep, and they should survive a profile reset like
 * environments do. One store, so pinning in one view updates every other at
 * once — the same shape as `quickButtons.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  githubAnswered, missingPins, parsePinKey, pullPinKey, readPins, ticketPinKey, togglePin as toggled,
  withoutClosedSessions, type Pin, type PinKind
} from '@kovan/core';
import { PinIcon } from './icons';
import { useMenuDismiss } from './menuDismiss';
import type { JiraIssue, PullSummary, Snapshot } from './types';

const SETTING = 'pins';

let pins: Pin[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

void window.kovan.settings().then((settings) => {
  pins = readPins(settings[SETTING]);
  notify();
});

function save(next: Pin[]): void {
  if (next === pins) return;
  pins = next;
  notify();
  void window.kovan.setSetting(SETTING, next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every pin, re-rendering when one changes. */
export function usePins(): Pin[] {
  return useSyncExternalStore(subscribe, () => pins);
}

/** The pinned keys, for a quick `has`. */
export function usePinnedKeys(): ReadonlySet<string> {
  const all = usePins();
  return useMemo(() => new Set(all.map((pin) => pin.key)), [all]);
}

export function togglePin(key: string, title?: string): void {
  save(toggled(pins, key, title, new Date()));
}

/** Drops the pins of sessions that have closed: their ids never come back. */
export function forgetClosedSessions(liveIds: ReadonlySet<string>): void {
  save(withoutClosedSessions(pins, liveIds));
}

/** Whether a list shows only what is pinned, per list and remembered. */
export function usePinnedOnly(list: PinKind): [boolean, (on: boolean) => void] {
  const storageKey = `kovan.pinnedOnly.${list}`;
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* the choice just isn't remembered */ }
  }, [storageKey]);
  return [on, set];
}

/**
 * The header's pin: shows only pinned rows. Dimmed while the list has
 * nothing pinned, but still there, so it never appears out of nowhere.
 */
export function PinnedOnlyButton({ on, count, onChange }: { on: boolean; count: number; onChange: (on: boolean) => void }) {
  const label = on ? 'Show everything' : count > 0 ? `Show pinned only (${count})` : 'Show pinned only (nothing pinned yet)';
  return (
    <button
      type="button"
      className={`icon-button pinned-only${on ? ' active' : ''}${count === 0 && !on ? ' none' : ''}`}
      aria-label={label} title={label} aria-pressed={on}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
    >
      <PinIcon size={13} />
    </button>
  );
}

/** What a list says when "pinned only" is on and nothing is pinned. */
export function NothingPinned() {
  return <p className="quiet">Nothing pinned. Hover a row and click its pin, or right-click it.</p>;
}

/**
 * The pin a row carries. Unpinned it appears on hover only; pinned it stays,
 * in clay, and a click unpins. It sits beside the row's own button rather
 * than inside it: a button can't hold another button.
 */
export function PinToggle({ pinKey, title, pinned, className = '' }: {
  pinKey: string; title: string; pinned: boolean; className?: string;
}) {
  const label = pinned ? 'Unpin' : 'Pin';
  return (
    <button
      type="button"
      className={`icon-button pin-toggle${pinned ? ' on' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label} title={label} aria-pressed={pinned}
      onClick={(e) => { e.stopPropagation(); togglePin(pinKey, title); }}
    >
      <PinIcon size={11} />
    </button>
  );
}

export interface RowMenuItem {
  label: string;
  run: () => void;
}

/**
 * A row's right-click menu: Pin or Unpin first, then whatever the row adds
 * (open it on its service, copy its link). Portalled and fixed at the
 * pointer, because the sidebar is CSS-zoomed and would scale a fixed
 * position inside it (item 104).
 */
export function useRowMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: RowMenuItem[] }>();
  const [place, setPlace] = useState<{ top: number; left: number }>();
  const box = useRef<HTMLDivElement>(null);
  useMenuDismiss(Boolean(menu), () => setMenu(undefined));

  // Kept inside the window: a right-click near the bottom or the right edge
  // opens the menu up or to the left instead of off screen.
  useLayoutEffect(() => {
    if (!menu || !box.current) { setPlace(undefined); return; }
    const { width, height } = box.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, menu.y + height > window.innerHeight - 8 ? menu.y - height : menu.y)
    });
  }, [menu]);

  const open = useCallback((event: React.MouseEvent, pinKey: string, title: string, pinned: boolean, more: RowMenuItem[] = []) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{ label: pinned ? 'Unpin' : 'Pin', run: () => togglePin(pinKey, title) }, ...more]
    });
  }, []);

  const element = menu ? createPortal(
    <div
      ref={box}
      className="menu row-menu" role="menu"
      style={{ position: 'fixed', top: place?.top ?? menu.y, left: place?.left ?? menu.x, right: 'auto', visibility: place ? 'visible' : 'hidden' }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.items.map((item) => (
        <button key={item.label} type="button" role="menuitem" onClick={() => { setMenu(undefined); item.run(); }}>
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  ) : null;

  return { open, element };
}

/** The keys of every pull request the lists carry. */
export function loadedPullKeys(snapshot: Snapshot): Set<string> {
  return new Set(
    [...snapshot.blocked, ...snapshot.mine, ...snapshot.reviewRequested, ...snapshot.merged]
      .map((p) => pullPinKey(p.repo, p.number))
  );
}

type Kept<T> = { item?: T; error?: string; loading?: boolean };

export interface KeptPins {
  /** Pinned pull requests none of the lists carry, fetched by number. */
  pulls: PullSummary[];
  /** Pinned tickets the ticket list doesn't carry, fetched by key. */
  issues: JiraIssue[];
  /** Pins that couldn't be loaded, with why. */
  failed: { pin: Pin; kind: 'pull' | 'ticket'; error: string }[];
  retry: (key: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

/**
 * Fetches each pinned pull request or ticket the lists no longer carry, once
 * per launch, so it can stay in its list. Only after the service has
 * answered: before the first refresh every list is empty, and every pin
 * would look missing. One small request per kept item, and only for items
 * the user pinned — never on its own for anything else.
 */
export function useKeptPins(snapshot: Snapshot): KeptPins {
  const all = usePins();
  const [kept, setKept] = useState<Map<string, Kept<PullSummary | JiraIssue>>>(new Map());
  const asked = useRef(new Set<string>());

  const pullsReady = githubAnswered(snapshot) && !snapshot.booting;
  const ticketsReady = snapshot.connected.includes('jira') && Boolean(snapshot.refreshedAt.jira) &&
    !snapshot.errors.some((e) => e.provider === 'jira') && !snapshot.booting;

  const missingPulls = useMemo(
    () => (pullsReady ? missingPins(all, 'pull', loadedPullKeys(snapshot)) : []),
    [all, snapshot, pullsReady]
  );
  const missingTickets = useMemo(
    () => (ticketsReady ? missingPins(all, 'ticket', new Set(snapshot.tickets.map((t) => ticketPinKey(t.key)))) : []),
    [all, snapshot.tickets, ticketsReady]
  );

  const fetchOne = useCallback((pin: Pin) => {
    const target = parsePinKey(pin.key);
    if (!target || target.kind === 'session') return;
    asked.current.add(pin.key);
    setKept((current) => new Map(current).set(pin.key, { loading: true }));
    const load: Promise<PullSummary | JiraIssue> = target.kind === 'pull'
      ? window.kovan.pullSummary(target.repo, target.number)
      : window.kovan.ticketDetail(target.key);
    load.then(
      (item) => setKept((current) => new Map(current).set(pin.key, { item })),
      (err: unknown) => setKept((current) => new Map(current).set(pin.key, { error: errorText(err) }))
    );
  }, []);

  useEffect(() => {
    for (const pin of [...missingPulls, ...missingTickets]) {
      if (!asked.current.has(pin.key)) fetchOne(pin);
    }
  }, [missingPulls, missingTickets, fetchOne]);

  const retry = useCallback((key: string) => {
    const pin = pins.find((p) => p.key === key);
    if (pin) fetchOne(pin);
  }, [fetchOne]);

  return useMemo(() => {
    const pulls: PullSummary[] = [];
    const issues: JiraIssue[] = [];
    const failed: KeptPins['failed'] = [];
    for (const pin of missingPulls) {
      const entry = kept.get(pin.key);
      if (entry?.item) pulls.push(entry.item as PullSummary);
      else if (entry?.error) failed.push({ pin, kind: 'pull', error: entry.error });
    }
    for (const pin of missingTickets) {
      const entry = kept.get(pin.key);
      if (entry?.item) issues.push(entry.item as JiraIssue);
      else if (entry?.error) failed.push({ pin, kind: 'ticket', error: entry.error });
    }
    return { pulls, issues, failed, retry };
  }, [missingPulls, missingTickets, kept, retry]);
}

/**
 * A pin that couldn't be loaded: deleted, no access, or the service is down.
 * It says so and offers Retry and Unpin — never unpinned by itself.
 */
export function FailedPinRow({ pin, label, error, onRetry }: { pin: Pin; label: string; error: string; onRetry: () => void }) {
  return (
    <li>
      <div className="row pin-failed">
        <span className="row-top">
          <span className="row-num">{label}</span>
          <span className="row-title">{pin.title ?? 'Pinned'}</span>
        </span>
        <span className="row-state">
          <span className="state" title={error}><span className="dot" />Couldn't load it</span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onRetry}>Retry</button>
          <button type="button" className="link" onClick={() => togglePin(pin.key)}>Unpin</button>
        </span>
      </div>
    </li>
  );
}
