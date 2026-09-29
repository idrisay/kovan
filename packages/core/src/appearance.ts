/**
 * Themes and the appearance options on top of them (item 96).
 *
 * Shared by both processes: the renderer paints with it, and the main process
 * needs a theme's tone for native chrome (`nativeTheme`, the window's first
 * paint). Kept free of DOM and Node so either can import it.
 */

/** Every theme. The first two are the originals; the rest were picked from
 *  the reviewers' proposals on the themes design page. */
export type ThemeId = 'dark' | 'light' | 'oled' | 'graphite' | 'ember' | 'contrast' | 'paper';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  /** Which of the two base palettes it is drawn over — decides native
   *  chrome and every `data-theme='light'` rule in the CSS. */
  tone: 'light' | 'dark';
  /** The rail colour, for the window's first paint before CSS loads. */
  rail: string;
  /** Reading surface, text and accent — for the picker's little preview. */
  editor: string;
  text: string;
  accent: string;
  hint: string;
}

export const THEMES: ThemeInfo[] = [
  { id: 'dark', label: 'Dark', tone: 'dark', rail: '#0d0e11', editor: '#191b20', text: '#dad8d3', accent: '#d97757', hint: 'The default: warm, dark.' },
  { id: 'light', label: 'Light', tone: 'light', rail: '#edebe5', editor: '#fbfaf7', text: '#2a2b2f', accent: '#c0603c', hint: 'Warm light.' },
  { id: 'oled', label: 'OLED Black', tone: 'dark', rail: '#000000', editor: '#0c0d0f', text: '#d5d5d1', accent: '#e47e5d', hint: 'True black, the least glow in a dark room.' },
  { id: 'graphite', label: 'Cool Graphite', tone: 'dark', rail: '#0e1116', editor: '#1a1f28', text: '#ccd3dc', accent: '#e07857', hint: 'A cooler, blue-grey dark.' },
  { id: 'ember', label: 'Ember Low Light', tone: 'dark', rail: '#100f0e', editor: '#1c1a18', text: '#c4bbaf', accent: '#d17759', hint: 'Dim and warm, for long evenings.' },
  { id: 'contrast', label: 'High Contrast', tone: 'dark', rail: '#000000', editor: '#101114', text: '#ffffff', accent: '#ff8a5b', hint: 'Maximum clarity; status always has a shape.' },
  { id: 'paper', label: 'Paper Soft', tone: 'light', rail: '#eae7df', editor: '#f7f6f1', text: '#4a4742', accent: '#c0603c', hint: 'Softer light, less glare.' }
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && BY_ID.has(value as ThemeId);
}

export function themeInfo(id: ThemeId): ThemeInfo {
  return BY_ID.get(id) ?? THEMES[0]!;
}

/**
 * The setting: one theme held regardless of the OS, or one of two ways of
 * switching between a day theme and a night theme — with macOS's own
 * appearance (which, set to Auto, follows sunrise and sunset), or at set times.
 */
export type ThemeChoice = 'system' | 'schedule' | ThemeId;

export interface ThemeSchedule {
  day: ThemeId;
  night: ThemeId;
  /** "HH:MM", local time. */
  dayStart: string;
  nightStart: string;
}

export const DEFAULT_SCHEDULE: ThemeSchedule = { day: 'light', night: 'dark', dayStart: '07:00', nightStart: '19:00' };

/** "07:30" → 450. Anything unreadable → undefined. */
export function clockMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : undefined;
}

/** Is it day at `now`, by the schedule's two times? Handles a day that
 *  wraps midnight (a night-shift schedule), and falls back to 07–19. */
export function isDaytime(schedule: Pick<ThemeSchedule, 'dayStart' | 'nightStart'>, now: Date): boolean {
  const start = clockMinutes(schedule.dayStart) ?? 7 * 60;
  const end = clockMinutes(schedule.nightStart) ?? 19 * 60;
  const t = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** A choice resolved to the one theme to paint right now. */
export function resolveTheme(
  choice: ThemeChoice,
  schedule: ThemeSchedule,
  context: { osLight: boolean; now: Date }
): ThemeId {
  if (choice === 'system') return context.osLight ? schedule.day : schedule.night;
  if (choice === 'schedule') return isDaytime(schedule, context.now) ? schedule.day : schedule.night;
  return isThemeId(choice) ? choice : 'dark';
}

/**
 * Accents. Curated rather than free, because an accent that shares a colour
 * family with a status colour starts to read as that status — the design
 * page measured it: Teal and Rose are clear of all five, the rest sit close
 * to one and are marked so. 'macos' follows System Settings.
 */
export type AccentId = 'clay' | 'rose' | 'teal' | 'violet' | 'ocean' | 'slate' | 'ochre' | 'macos';

export interface AccentInfo {
  id: AccentId;
  label: string;
  /** Swatch colour for the picker (the dark shade). */
  swatch: string;
  /** The status it can be mistaken for, if any. */
  near?: string;
}

export const ACCENTS: AccentInfo[] = [
  { id: 'clay', label: 'Clay', swatch: '#d97757' },
  { id: 'teal', label: 'Teal', swatch: '#3fb0a0' },
  { id: 'rose', label: 'Rose', swatch: '#d9749a' },
  { id: 'violet', label: 'Violet', swatch: '#a98be0', near: 'Merged' },
  { id: 'ocean', label: 'Ocean', swatch: '#5a9bd8', near: 'Awaiting review' },
  { id: 'slate', label: 'Slate', swatch: '#7d97b0', near: 'Awaiting review' },
  { id: 'ochre', label: 'Ochre', swatch: '#c9a040', near: 'Checks running' },
  { id: 'macos', label: 'macOS', swatch: 'conic-gradient(#ff453a, #ffd60a, #32d74b, #0a84ff, #bf5af2, #ff453a)' }
];

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === 'string' && ACCENTS.some((a) => a.id === value);
}

export type Density = 'comfortable' | 'compact';
export type TerminalColors = 'integrated' | 'boosted';
