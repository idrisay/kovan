/**
 * Where a menu hung from a button fits (item 174).
 */

/** The menu's preferred width; it narrows to fit, its model ids cut short. */
const MENU_WIDTH = 340;
const MENU_GAP = 8;

export interface MenuPlace { alignRight: boolean; maxWidth?: number }

/**
 * Where the model menu fits beside `anchor`: hung from its left edge when
 * there is room to the right, else from its right edge, and never wider than
 * the side it opens to. Room is counted to the edge of the nearest ancestor
 * that clips (the detail pane beside a docked terminal), not the window's.
 */
export function menuPlace(anchor: HTMLElement): MenuPlace {
  const box = anchor.getBoundingClientRect();
  let left = 0;
  let right = window.innerWidth;
  for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
      const clip = el.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
  }
  return placeMenu(box.left, box.right, left, right);
}

/** The sums behind `menuPlace`, apart from the DOM so they can be tested. */
export function placeMenu(anchorLeft: number, anchorRight: number, clipLeft: number, clipRight: number): MenuPlace {
  const toRight = clipRight - anchorLeft - MENU_GAP;
  const toLeft = anchorRight - clipLeft - MENU_GAP;
  if (toRight >= MENU_WIDTH) return { alignRight: false };
  if (toLeft >= MENU_WIDTH) return { alignRight: true };
  return toLeft > toRight ? { alignRight: true, maxWidth: toLeft } : { alignRight: false, maxWidth: toRight };
}
