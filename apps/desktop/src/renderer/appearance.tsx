import { useSyncExternalStore } from 'react';
import {
  DEFAULT_SETTINGS, isAccentId, isThemeId, resolveTheme, themeInfo,
  type AccentId, type Density, type TerminalColors, type ThemeChoice, type ThemeId
} from '@kovan/core';

/**
 * Everything about how Kovan looks (item 96), as one store: App.tsx starts it,
 * Settings edits it, the terminals read it. What it paints is a handful of
 * attributes on `<html>` — `data-theme` (the tone, light or dark),
 * `data-palette`, `data-accent`, `data-status`, `data-shapes`,
 * `data-density` — and `styles.css` keys everything off those.
 */
export interface Appearance {
  theme: ThemeChoice;
  dayTheme: ThemeId;
  nightTheme: ThemeId;
  dayStart: string;
  nightStart: string;
  accent: AccentId;
  colorSafeStatus: boolean;
  statusShapes: boolean;
  density: Density;
  terminalColors: TerminalColors;
}

const KEYS: Record<keyof Appearance, `appearance.${string}`> = {
  theme: 'appearance.theme',
  dayTheme: 'appearance.dayTheme',
  nightTheme: 'appearance.nightTheme',
  dayStart: 'appearance.dayStart',
  nightStart: 'appearance.nightStart',
  accent: 'appearance.accent',
  colorSafeStatus: 'appearance.colorSafeStatus',
  statusShapes: 'appearance.statusShapes',
  density: 'appearance.density',
  terminalColors: 'appearance.terminalColors'
};

function defaults(): Appearance {
  const out = {} as Record<string, unknown>;
  for (const [field, key] of Object.entries(KEYS)) {
    out[field] = DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS];
  }
  return out as unknown as Appearance;
}

let current: Appearance = defaults();
/** The theme actually painted — for the terminal, and to tell when a
 *  scheduled switch is due. */
let painted: ThemeId | undefined;
/** The macOS accent, "#rrggbb", when that accent is chosen. */
let systemAccent: string | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const osLight = () => matchMedia('(prefers-color-scheme: light)').matches;

/** The theme the settings ask for at this moment. */
export function wantedTheme(a: Appearance = current): ThemeId {
  return resolveTheme(a.theme, { day: a.dayTheme, night: a.nightTheme, dayStart: a.dayStart, nightStart: a.nightStart }, {
    osLight: osLight(),
    now: new Date()
  });
}

export function paintedTheme(): ThemeId {
  return painted ?? wantedTheme();
}

function paint() {
  const root = document.documentElement;
  const id = wantedTheme();
  const info = themeInfo(id);
  const contrast = id === 'contrast';
  root.dataset.theme = info.tone;
  if (id === 'dark' || id === 'light') delete root.dataset.palette;
  else root.dataset.palette = id;

  if (current.accent === 'clay') delete root.dataset.accent;
  else root.dataset.accent = current.accent;
  // The macOS accent is any colour at all, so it arrives as the token itself
  // rather than a named rule; the hover step is mixed from it.
  if (current.accent === 'macos' && systemAccent) {
    root.style.setProperty('--clay', systemAccent);
    root.style.setProperty('--clay-bright', `color-mix(in srgb, ${systemAccent} 80%, ${info.tone === 'light' ? '#000' : '#fff'})`);
  } else {
    root.style.removeProperty('--clay');
    root.style.removeProperty('--clay-bright');
  }

  if (current.colorSafeStatus) root.dataset.status = 'safe';
  else delete root.dataset.status;
  // High Contrast always shows shapes: it is the theme for when colour alone
  // is the hardest to read.
  if (current.statusShapes || contrast) root.dataset.shapes = '';
  else delete root.dataset.shapes;
  root.dataset.density = current.density;

  // Native chrome (scrollbars, a native <select>): 'system' has to stay
  // 'system', or Electron would pin prefers-color-scheme and "System" could
  // never see macOS switch again.
  void window.kovan.setNativeTheme(current.theme === 'system' ? 'system' : info.tone);

  painted = id;
  emit();
}

async function refreshSystemAccent() {
  if (current.accent !== 'macos') return;
  const next = await window.kovan.systemAccent().catch(() => undefined);
  if (next && next !== systemAccent) {
    systemAccent = next;
    paint();
  }
}

let started = false;

/**
 * Loads the saved appearance and keeps it painted: live when "System" is the
 * choice and macOS switches, and on the schedule — but a scheduled switch
 * waits until Kovan is not the window in front, or until it comes back to
 * the front, so the screen never changes under someone reading a diff.
 */
export function startAppearance(): void {
  if (started) return;
  started = true;
  paint();
  void window.kovan.settings().then((settings) => {
    const next = { ...current } as Record<string, unknown>;
    for (const [field, key] of Object.entries(KEYS)) {
      if (settings[key] !== undefined) next[field] = settings[key];
    }
    // An old or hand-edited value falls back rather than painting nothing.
    const loaded = next as unknown as Appearance;
    if (loaded.theme !== 'system' && loaded.theme !== 'schedule' && !isThemeId(loaded.theme)) loaded.theme = 'system';
    if (!isThemeId(loaded.dayTheme)) loaded.dayTheme = 'light';
    if (!isThemeId(loaded.nightTheme)) loaded.nightTheme = 'dark';
    if (!isAccentId(loaded.accent)) loaded.accent = 'clay';
    current = loaded;
    paint();
    void refreshSystemAccent();
  });

  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (current.theme === 'system') paint();
  });
  const catchUp = () => {
    if (wantedTheme() !== painted) paint();
  };
  setInterval(() => {
    if (current.theme === 'schedule' && !document.hasFocus()) catchUp();
  }, 60_000);
  window.addEventListener('focus', () => {
    catchUp();
    // macOS gives no event for an accent change; coming back to the window
    // after changing it in System Settings is the moment it matters.
    void refreshSystemAccent();
  });
}

/** The current appearance, re-rendering on any change. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current);
}

/** Painted theme id, re-rendering when it changes. */
export function usePaintedTheme(): ThemeId {
  return useSyncExternalStore(subscribe, paintedTheme);
}

/** Change one appearance setting: painted at once, saved to disk. */
export function setAppearance<K extends keyof Appearance>(field: K, value: Appearance[K]): void {
  current = { ...current, [field]: value };
  paint();
  if (field === 'accent') void refreshSystemAccent();
  void window.kovan.setSetting(KEYS[field], value);
}

export function subscribeAppearance(listener: () => void): () => void {
  return subscribe(listener);
}

export function getAppearance(): Appearance {
  return current;
}
