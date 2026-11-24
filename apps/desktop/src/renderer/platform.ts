/**
 * macOS or Linux, for the few places the window behaves differently.
 *
 * Shortcuts: what macOS spells ⌘K is Ctrl+K on Linux. Except in a terminal,
 * where Ctrl+K, Ctrl+F and Ctrl+P already belong to the shell (cut the line,
 * cursor forward, previous command); there the shell keeps them, as in any
 * Linux terminal app. On macOS ⌘ never reaches a shell, so it is always ours.
 */

export const isMac = window.kovan.platform === 'darwin';

type Keys = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { target?: EventTarget | null };

/** ⌘ alone on macOS, Ctrl alone elsewhere (and not inside a terminal). */
export function isAppShortcut(event: Keys): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (isMac) return event.metaKey && !event.ctrlKey;
  if (!event.ctrlKey || event.metaKey) return false;
  return !(event.target instanceof Element && event.target.closest('.xterm'));
}

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function keyLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
