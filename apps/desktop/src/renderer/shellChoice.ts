/**
 * The shell new terminals open in (item 126): the switch in Sessions' + menu
 * and Settings › Text & terminal both read and write this one choice, which
 * main reads again when it spawns, so the two never disagree.
 */
import { useSyncExternalStore } from 'react';
import type { ShellOption } from './types';

const SETTING = 'terminal.shell';

interface State {
  shells: ShellOption[];
  /** The saved path; empty means the login shell. */
  saved: string;
}

let state: State = { shells: [], saved: '' };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

void Promise.all([window.kovan.shells(), window.kovan.settings()]).then(([shells, settings]) => {
  const saved = settings[SETTING];
  state = { shells, saved: typeof saved === 'string' ? saved : '' };
  notify();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The installed shells and which one is chosen; a saved shell since uninstalled reads as the login shell, as main spawns it. */
export function useShellChoice(): { shells: ShellOption[]; chosen?: ShellOption } {
  const current = useSyncExternalStore(subscribe, () => state);
  const chosen = current.shells.find((s) => s.path === current.saved) ?? current.shells.find((s) => s.login);
  return { shells: current.shells, chosen };
}

/** Saves the shell for every new terminal from now on. */
export function setShell(path: string): void {
  state = { ...state, saved: path };
  notify();
  void window.kovan.setSetting(SETTING, path);
}
