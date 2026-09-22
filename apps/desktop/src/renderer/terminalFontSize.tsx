import { useCallback, useEffect, useState } from 'react';
import { MinusIcon, PlusIcon } from './icons';

/**
 * One font size for every terminal in the app — the docked one on a pull
 * request or ticket, and the Sessions tab's own — the same way the sidebar
 * has one width rather than one per view. A preference, not a credential, so
 * it lives in localStorage next to the sidebar width and the terminal dock
 * position, not in the settings store.
 */
const KEY = 'baton.terminal-font-size';
const MIN = 9;
const MAX = 22;
const DEFAULT = 12;

function read(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function write(px: number) {
  try { localStorage.setItem(KEY, String(px)); } catch { /* a preference, not a requirement */ }
}

const clamp = (px: number) => Math.min(MAX, Math.max(MIN, px));

/**
 * A step taken anywhere in this window (Settings' own stepper, or another
 * terminal's, since the control now lives in only one place but several
 * `useTerminalFontSize()` instances are mounted at once — one per docked
 * terminal, one for the Sessions tab, one for Settings). A plain window
 * event, not React state lifted somewhere shared: every instance already
 * needs to react to the *other* cross-window case, Cmd+=/Cmd+- arriving over
 * IPC from main, so this reuses that same "apply a step" path instead of
 * adding a second, different way instances stay in sync.
 */
const LOCAL_STEP_EVENT = 'baton:terminal-font-local-step';

/**
 * The current terminal font size, plus a stepper. Cmd+=/Cmd+- (intercepted in
 * main — see the note in `main/index.ts` on `before-input-event`, which is
 * what used to just zoom the whole window) and every mounted copy of this
 * hook's own stepper all drive the exact same state, so every terminal in
 * the app and Settings' own control move together regardless of which one
 * you used to change it.
 */
export function useTerminalFontSize(): [number, (step: number) => void] {
  const [size, setSize] = useState(read);

  const applyStep = useCallback((step: number) => {
    setSize((current) => {
      const next = clamp(current + step);
      write(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onLocalStep = (event: Event) => applyStep((event as CustomEvent<number>).detail);
    window.addEventListener(LOCAL_STEP_EVENT, onLocalStep);
    const offIpc = window.baton.onFontSizeStep(applyStep);
    return () => {
      window.removeEventListener(LOCAL_STEP_EVENT, onLocalStep);
      offIpc();
    };
  }, [applyStep]);

  // Dispatched rather than applied directly: the listener above (registered
  // by every instance, including this one) is the single place a step is
  // actually applied, so a click here cannot double-apply on top of it.
  const bump = useCallback((step: number) => {
    window.dispatchEvent(new CustomEvent(LOCAL_STEP_EVENT, { detail: step }));
  }, []);

  return [size, bump];
}

export function FontSizeControl({ size, onBump }: { size: number; onBump: (step: number) => void }) {
  return (
    <div className="font-size-control" role="group" aria-label="Terminal font size" title="Terminal font size (⌘+ / ⌘−)">
      <button
        type="button" className="icon-button" aria-label="Smaller text"
        disabled={size <= MIN} onClick={() => onBump(-1)}
      >
        <MinusIcon />
      </button>
      <span className="font-size-value">{size}</span>
      <button
        type="button" className="icon-button" aria-label="Larger text"
        disabled={size >= MAX} onClick={() => onBump(1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
