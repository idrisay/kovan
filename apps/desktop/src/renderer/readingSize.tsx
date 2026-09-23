import { useCallback, useEffect, useState } from 'react';
import { MinusIcon, PlusIcon } from './icons';

/**
 * How big a pull request's, ticket's or Sentry error's own text reads — the
 * description, comments, review threads, everything in the detail pane —
 * independently of the terminal's font size and of the app's chrome.
 *
 * A zoom on the detail column rather than a font-size variable: that pane
 * sets dozens of sizes (headings, code, chips, avatars, line heights) and
 * scaling only the text would leave them out of proportion. A preference,
 * so it lives in localStorage like the terminal size and the sidebar width.
 */
const KEY = 'baton.reading-size';
const MIN = 80;
const MAX = 160;
const STEP = 10;
const DEFAULT = 100;
const CHANGED = 'baton:reading-size';

function read(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function apply(percent: number) {
  document.documentElement.style.setProperty('--reading-zoom', String(percent / 100));
}

/** Before the first render, so a detail pane never paints at 100% and then jumps. */
export function restoreReadingSize() {
  apply(read());
}

export function useReadingSize(): [number, (step: number) => void] {
  const [percent, setPercent] = useState(read);

  useEffect(() => {
    const onChange = (event: Event) => setPercent((event as CustomEvent<number>).detail);
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  const bump = useCallback((direction: number) => {
    const next = Math.min(MAX, Math.max(MIN, read() + direction * STEP));
    try { localStorage.setItem(KEY, String(next)); } catch { /* a preference, not a requirement */ }
    apply(next);
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }));
  }, []);

  return [percent, bump];
}

export function ReadingSizeControl() {
  const [percent, bump] = useReadingSize();
  return (
    <div className="font-size-control" role="group" aria-label="Ticket and pull request text size">
      <button type="button" className="icon-button" aria-label="Smaller reading text" disabled={percent <= MIN} onClick={() => bump(-1)}>
        <MinusIcon />
      </button>
      <span className="font-size-value">{percent}%</span>
      <button type="button" className="icon-button" aria-label="Larger reading text" disabled={percent >= MAX} onClick={() => bump(1)}>
        <PlusIcon />
      </button>
    </div>
  );
}
