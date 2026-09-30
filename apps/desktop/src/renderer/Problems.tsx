/**
 * Connection problems (item 120, option B). No strip across the top: a
 * service that stops answering gets a toast that fades, its name in the
 * status bar turns into a red chip, and any service's name there opens this
 * popover — what's wrong now (Retry, Copy details) and the problems before.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuDismiss } from './menuDismiss';
import type { PolledProvider, Problem } from './types';

const RETRYABLE = new Set<string>(['github', 'jira', 'sentry']);

export function useProblems(): { log: Problem[]; started: Problem[] } {
  const [state, setState] = useState<{ log: Problem[]; started: Problem[] }>({ log: [], started: [] });
  useEffect(() => {
    void window.baton.problems().then((log) => setState((s) => (s.log.length ? s : { log, started: [] })));
    return window.baton.onProblems(setState);
  }, []);
  return state;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "16:41", "yest 11:02", "Mon 09:14", "12 Sep". */
function when(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return clock(ms);
  if (days === 1) return `yest ${clock(ms)}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(ms)}`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function lasted(p: Problem): string {
  const minutes = Math.round(((p.clearedAt ?? p.lastAt) - p.startedAt) / 60_000);
  if (minutes < 1) return 'cleared';
  return minutes < 60 ? `cleared after ${minutes} min` : `cleared after ${Math.round(minutes / 60)} h`;
}

function CopyDetails({ problem }: { problem: Problem }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button" className="link"
      onClick={() => {
        const text = `${problem.title} (${problem.detail})\nSince ${new Date(problem.startedAt).toLocaleString()} · ${problem.count} time${problem.count === 1 ? '' : 's'}\n\n${problem.raw}`;
        void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}
    >
      {copied ? 'Copied' : 'Copy details'}
    </button>
  );
}

/** Opened from a service's name in the status bar; placed above it. */
export function ProblemsPopover({ anchor, log, onClose }: { anchor: HTMLElement; log: Problem[]; onClose: () => void }) {
  useMenuDismiss(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number }>();
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const width = box.current?.offsetWidth ?? 380;
    setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), bottom: window.innerHeight - r.top + 6 });
  }, [anchor]);
  const now = log.filter((p) => p.clearedAt === undefined);
  const earlier = log.filter((p) => p.clearedAt !== undefined).slice(0, 20);
  return createPortal(
    <div
      ref={box} className="menu problems-pop" role="dialog" aria-label="Connection problems"
      style={place ? { left: place.left, bottom: place.bottom } : { left: -9999, bottom: 0 }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="menu-head">Now</p>
      {now.length === 0 ? (
        <p className="problems-none">Every service answered on its last refresh.</p>
      ) : now.map((p) => (
        <div key={p.id} className="problem-now">
          <span className="dot fail" />
          <span className="problem-text">
            <strong>{p.title}</strong>
            <small>
              {p.detail} · since {when(p.startedAt)}{p.count > 1 ? ` · ${p.count} times` : ''}
            </small>
            <CopyDetails problem={p} />
          </span>
          {RETRYABLE.has(p.provider) && (
            <button type="button" className="problem-retry" onClick={() => void window.baton.refreshProvider(p.provider as PolledProvider)}>
              Retry
            </button>
          )}
        </div>
      ))}
      <p className="menu-head">Earlier</p>
      {earlier.length === 0 ? (
        <p className="problems-none">Nothing yet. Problems are kept here once they clear.</p>
      ) : (
        <div className="problems-earlier">
          {earlier.map((p) => (
            <div key={p.id} className="problem-row" title={`${p.detail}${p.count > 1 ? ` · ${p.count} times` : ''}\n\n${p.raw}`}>
              <span className="problem-when">{when(p.startedAt)}</span>
              <span className="problem-title">{p.title}</span>
              <span className="problem-cleared">{lasted(p)}</span>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}

const TOAST_MS = 8_000;

/** One toast per problem that just started; fades by itself. */
export function ProblemToast({ started, onDetails }: { started: Problem[]; onDetails: () => void }) {
  const [shown, setShown] = useState<Problem>();
  useEffect(() => {
    const latest = started[0];
    if (!latest) return undefined;
    setShown(latest);
    const timer = setTimeout(() => setShown(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [started]);
  if (!shown) return null;
  return createPortal(
    <div className="problem-toast" role="status">
      <strong>{shown.title}</strong>
      <span>{shown.detail}. Baton tries again at the next refresh; what's on screen is from the last one that worked.</span>
      <span className="problem-toast-actions">
        <button type="button" className="link" onClick={() => { setShown(undefined); onDetails(); }}>Details</button>
        <button type="button" className="link" onClick={() => setShown(undefined)}>Dismiss</button>
      </span>
    </div>,
    document.body
  );
}
