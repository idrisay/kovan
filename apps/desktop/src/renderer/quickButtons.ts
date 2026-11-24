/**
 * Which quick-model buttons the detail headers show (item 124): Summarize and
 * Review on a pull request, Condense on a ticket.
 *
 * Summarize and Review are off until the user turns them on in Settings ›
 * Agents; Condense stays on, as it was. Turning one off hides its button and
 * its card, and keeps its setup (the models) for when it comes back.
 *
 * A store rather than a read per pane, so ticking a box in Settings updates
 * the header behind the sheet at once — the same shape as `appearance.tsx`.
 */

import { useSyncExternalStore } from 'react';

export type QuickButtonId = 'summarize' | 'review' | 'condense';

export const QUICK_BUTTONS: { id: QuickButtonId; setting: string; label: string; note: string; byDefault: boolean }[] = [
  { id: 'summarize', setting: 'buttons.summarize', label: 'Summarize', note: 'On a pull request: why it is blocked, from its reviews, threads and checks. Quick model, free.', byDefault: false },
  { id: 'review', setting: 'buttons.review', label: 'Review', note: 'On a pull request: approve or request changes, read from the diff. Takes a few minutes; nothing reaches GitHub until you pick.', byDefault: false },
  { id: 'condense', setting: 'buttons.condense', label: 'Condense earlier comments', note: 'On a ticket with a long history: shortens it for the next agent run. Quick model, free.', byDefault: true }
];

type Shown = Record<QuickButtonId, boolean>;

let shown: Shown = Object.fromEntries(QUICK_BUTTONS.map((b) => [b.id, b.byDefault])) as Shown;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

void window.kovan.settings().then((settings) => {
  const next = { ...shown };
  for (const button of QUICK_BUTTONS) {
    const stored = settings[button.setting];
    if (typeof stored === 'boolean') next[button.id] = stored;
  }
  shown = next;
  notify();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Which buttons are on, re-rendering when one changes. */
export function useQuickButtons(): Shown {
  return useSyncExternalStore(subscribe, () => shown);
}

/** Shows or hides one button everywhere at once, and saves it. */
export function setQuickButton(id: QuickButtonId, on: boolean): void {
  shown = { ...shown, [id]: on };
  notify();
  const button = QUICK_BUTTONS.find((b) => b.id === id)!;
  void window.kovan.setSetting(button.setting, on);
}
