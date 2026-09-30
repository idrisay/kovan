/**
 * The Activity inbox and its toasts (item 86).
 *
 * Main notices the events (see `main/activityFeed.ts`); this shows them. The
 * inbox is a rail tab like any other — the list on the left, and a click opens
 * that pull request or ticket in the pane beside it, so reading down the
 * inbox is reading the things themselves. A toast is the same event arriving
 * while the window is in front; it goes by itself, and the inbox keeps it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { activityLabel, formatAge, type ActivityKind } from '@kovan/core';
import type { ActivityEvent } from './types';

const TONE: Record<ActivityKind, string> = {
  'review-requested': 'waiting',
  approved: 'pass',
  'changes-requested': 'fail',
  'new-ticket': 'waiting',
  'new-comment': 'running',
  mentioned: 'running'
};

/** The inbox, kept in step with main. */
export function useActivity(): {
  inbox: ActivityEvent[];
  unread: number;
  markRead: (ids: string[] | 'all') => void;
  /** A notification clicked before this window existed: the subject it asked for, read once. */
  launchOpen?: string;
} {
  const [inbox, setInbox] = useState<ActivityEvent[]>([]);
  const [launchOpen, setLaunchOpen] = useState<string>();
  useEffect(() => {
    let live = true;
    // The only call that reads it: main hands the pending subject out once.
    void window.kovan.activity().then((state) => {
      if (!live) return;
      setInbox(state.inbox);
      if (state.open !== undefined) setLaunchOpen(state.open);
    });
    const off = window.kovan.onActivity((next) => setInbox(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  const markRead = useCallback((ids: string[] | 'all') => {
    // Shown read at once; main's answer confirms it.
    setInbox((current) => current.map((e) => (ids === 'all' || ids.includes(e.id) ? { ...e, read: true } : e)));
    void window.kovan.activityRead(ids).then(setInbox);
  }, []);
  return { inbox, unread: inbox.filter((e) => !e.read).length, markRead, launchOpen };
}

function dayOf(at: number, now: number): 'Today' | 'Yesterday' | 'Earlier' {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return 'Today';
  if (at >= start.getTime() - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

function Line({ event }: { event: ActivityEvent }) {
  return (
    <>
      <span className="row-top">
        <span className="row-num">{event.label}</span>
        <span className="row-title">{event.title}</span>
      </span>
      <span className="row-state">
        <span className="state">
          <span className={`dot ${TONE[event.kind]}`} />
          {activityLabel(event.kind)}
        </span>
        {event.who && <span className="activity-who">{event.who}</span>}
        <span className="spacer" />
        <span className="row-age">{formatAge(new Date(event.at).toISOString())}</span>
      </span>
      {/* A mention says what was written, not only where (item 119). */}
      {event.excerpt && <span className="activity-excerpt">“{event.excerpt}”</span>}
    </>
  );
}

export function ActivityList({ inbox, filter, selectedId, onOpen }: {
  inbox: ActivityEvent[];
  filter: string;
  selectedId?: string;
  onOpen: (event: ActivityEvent) => void;
}) {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? inbox.filter((e) => `${e.title} ${e.label} ${e.who ?? ''} ${e.excerpt ?? ''} ${activityLabel(e.kind)}`.toLowerCase().includes(q))
    : inbox;
  if (shown.length === 0) {
    return (
      <p className="quiet">
        {q
          ? 'Nothing matches.'
          : 'Nothing yet. Review requests, approvals, changes requested, new tickets and new comments on your pull requests will show up here.'}
      </p>
    );
  }
  const now = Date.now();
  const days: { day: string; events: ActivityEvent[] }[] = [];
  for (const event of shown) {
    const day = dayOf(event.at, now);
    const last = days[days.length - 1];
    if (last?.day === day) last.events.push(event);
    else days.push({ day, events: [event] });
  }
  return (
    <>
      {days.map(({ day, events }) => (
        <section key={day}>
          <h3 className="activity-day">{day}</h3>
          <ul className="rows">
            {events.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className={`row activity-row${event.read ? ' read' : ''}${event.id === selectedId ? ' selected' : ''}`}
                  aria-label={`${event.read ? '' : 'Unread: '}${activityLabel(event.kind)}, ${event.label}, ${event.title}`}
                  onClick={() => onOpen(event)}
                >
                  <Line event={event} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const TOAST_MS = 8_000;
const MAX_TOASTS = 3;

/**
 * New events while the window is in front. Newest on top, at most three; each
 * goes after eight seconds unless the pointer is on it. Open reads it and
 * goes there; ✕ only dismisses the toast — it stays unread in the inbox.
 * More than three at once says how many more, rather than dropping them
 * without a word.
 */
export function ActivityToasts({ onOpen, onShowAll }: {
  onOpen: (event: ActivityEvent) => void;
  onShowAll: () => void;
}) {
  // One state, so an arrival updates both in a single pure step.
  const [{ toasts, more }, setStack] = useState<{ toasts: ActivityEvent[]; more: number }>({ toasts: [], more: 0 });
  const hovered = useRef(false);

  useEffect(
    () => window.kovan.onActivityToast((events) =>
      // Main sends them newest first, the inbox's own order.
      setStack((current) => {
        const all = [...events, ...current.toasts];
        return {
          toasts: all.slice(0, MAX_TOASTS),
          more: current.more + Math.max(0, all.length - MAX_TOASTS)
        };
      })
    ),
    []
  );
  const setToasts = useCallback(
    (next: (toasts: ActivityEvent[]) => ActivityEvent[]) =>
      setStack((current) => {
        const toasts = next(current.toasts);
        return { toasts, more: toasts.length === 0 ? 0 : current.more };
      }),
    []
  );

  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((t) => t.id !== id)), [setToasts]);

  // One timer for the oldest, restarted as the stack changes; paused on hover.
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[toasts.length - 1]!;
    const timer = setInterval(() => {
      if (!hovered.current) dismiss(oldest.id);
    }, TOAST_MS);
    return () => clearInterval(timer);
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;
  return (
    <div
      className="toasts"
      role="status"
      aria-live="polite"
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
    >
      {toasts.map((event) => (
        <div key={event.id} className="toast">
          <div className="toast-head">
            <span className={`dot ${TONE[event.kind]}`} />
            <span className="toast-kind">{activityLabel(event.kind)}</span>
            <span className="spacer" />
            <button
              type="button" className="icon-button" aria-label="Dismiss" title="Dismiss (stays in Activity)"
              onClick={() => dismiss(event.id)}
            >
              ✕
            </button>
          </div>
          <div className="toast-subject">
            {event.label}{event.who ? ` · ${event.who}` : ''}
          </div>
          <div className="toast-title">{event.title}</div>
          {event.excerpt && <div className="toast-excerpt">“{event.excerpt}”</div>}
          <div className="toast-actions">
            <button
              type="button" className="ghost"
              onClick={() => {
                dismiss(event.id);
                onOpen(event);
              }}
            >
              Open
            </button>
            <span className="spacer" />
            <span className="row-age">just now</span>
          </div>
        </div>
      ))}
      {more > 0 && (
        <button type="button" className="link toast-more" onClick={() => { setToasts(() => []); onShowAll(); }}>
          +{more} more in Activity
        </button>
      )}
    </div>
  );
}

/** The settings behind the inbox, one per kind (approved and changes requested share one). */
export const ACTIVITY_SETTINGS: { setting: string; label: string; note: string }[] = [
  { setting: 'activity.reviewRequested', label: 'Review requested from you', note: 'Somebody asks you to review their pull request.' },
  { setting: 'activity.decisions', label: 'Your pull request approved or sent back', note: 'A reviewer approves, or asks for changes.' },
  { setting: 'activity.newTicket', label: 'New Jira ticket assigned to you', note: 'A ticket newly appears in Tickets.' },
  { setting: 'activity.newComment', label: 'New comment on your pull request', note: 'Somebody else comments, in the conversation or on the code.' }
];

export function ActivitySettings() {
  const [on, setOn] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void window.kovan.settings().then((settings) =>
      setOn(Object.fromEntries(ACTIVITY_SETTINGS.map(({ setting }) => [setting, settings[setting] !== false])))
    );
  }, []);
  return (
    <>
      <h3>Activity</h3>
      <p className="settings-note">
        What goes in the Activity inbox. While Kovan is in front, each shows as a toast for a few seconds;
        otherwise as a macOS notification, if notifications are on above. Turned off, it isn't recorded at all.
      </p>
      {ACTIVITY_SETTINGS.map(({ setting, label, note }) => (
        <label key={setting} className="checkbox-row" title={note}>
          <input
            type="checkbox"
            checked={on[setting] ?? true}
            onChange={(e) => {
              const value = e.target.checked;
              setOn((current) => ({ ...current, [setting]: value }));
              void window.kovan.setSetting(setting, value);
            }}
          />
          <span>{label}</span>
        </label>
      ))}
    </>
  );
}
