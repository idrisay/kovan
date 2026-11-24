/**
 * ⌘J (item 158), as in VS Code: the terminal of whatever you are looking at,
 * shown or hidden. App catches the key and asks; the view on screen answers
 * by taking the event (`preventDefault`). Nobody answering means there is no
 * terminal that belongs where you are, and App starts a new session instead.
 */

import { useEffect, useRef } from 'react';

const TOGGLE_TERMINAL = 'kovan-toggle-terminal';

/** True when a view on screen took it. */
export function toggleTerminal(): boolean {
  return !window.dispatchEvent(new Event(TOGGLE_TERMINAL, { cancelable: true }));
}

/** Answers ⌘J while `enabled`: only the view on screen should. */
export function useTerminalToggle(handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const on = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener(TOGGLE_TERMINAL, on);
    return () => window.removeEventListener(TOGGLE_TERMINAL, on);
  }, [enabled]);
}
