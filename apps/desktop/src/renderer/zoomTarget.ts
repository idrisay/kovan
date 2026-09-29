import { stepChromeSize, stepReadingSize, stepSidebarSize } from './readingSize';
import { stepTerminalFont } from './terminalFontSize';

/**
 * Where Cmd+=/Cmd+- goes.
 *
 * Main intercepts both keys (see `before-input-event` in `main/index.ts`) and
 * sends one step. Which size that step moves depends on the region you last
 * clicked or tabbed into — the sidebar, the reading pane, or a terminal — the
 * same "the thing you are looking at" rule an editor's zoom follows. Until
 * anything is clicked, and for clicks on chrome that is none of the three
 * (the rail, the titlebar), the previous target stands; the first one is the
 * terminal, which is what these keys moved before there was a choice.
 */
type Target = 'terminal' | 'sidebar' | 'reading' | 'chrome';

let target: Target = 'terminal';

function classify(node: EventTarget | null): Target | undefined {
  if (!(node instanceof Element)) return undefined;
  // The terminal first: a docked one sits inside the reading pane's column.
  if (node.closest('.term')) return 'terminal';
  // Item 103: the tab strip, a session's header and the status bar.
  if (node.closest('.pane-tabs, .term-head, .statusbar')) return 'chrome';
  if (node.closest('.queue')) return 'sidebar';
  if (node.closest('.detail.reading')) return 'reading';
  return undefined;
}

export function installZoomRouting(): void {
  const note = (event: Event) => {
    target = classify(event.target) ?? target;
  };
  document.addEventListener('pointerdown', note, true);
  document.addEventListener('focusin', note, true);

  window.baton.onFontSizeStep((step) => {
    if (target === 'sidebar') stepSidebarSize(step);
    else if (target === 'reading') stepReadingSize(step);
    else if (target === 'chrome') stepChromeSize(step);
    else stepTerminalFont(step);
  });
}
