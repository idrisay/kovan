/**
 * Reordering a list by hand: the drag-and-drop and ⌥↑ / ⌥↓ behind the
 * workspace's repository rows.
 */

/**
 * `list` with `item` taken out and put back just before or after `target`.
 * Unchanged when either is missing, or when they are the same thing.
 */
export function moveItem<T>(list: readonly T[], item: T, target: T, after: boolean): T[] {
  if (item === target || !list.includes(item) || !list.includes(target)) return [...list];
  const rest = list.filter((x) => x !== item);
  const at = rest.indexOf(target);
  rest.splice(after ? at + 1 : at, 0, item);
  return rest;
}

/** `list` with `item` moved one place up (-1) or down (+1); unchanged at an end. */
export function moveBy<T>(list: readonly T[], item: T, delta: -1 | 1): T[] {
  const at = list.indexOf(item);
  const target = list[at + delta];
  if (at < 0 || target === undefined) return [...list];
  return moveItem(list, item, target, delta === 1);
}

/**
 * True when `next` is `current` in another order: same items, same count.
 * What a stored order has to pass before it replaces one, so a stale or
 * mangled request can reorder a list but never add to it or drop from it.
 */
export function isReordering<T>(current: readonly T[], next: readonly T[]): boolean {
  if (current.length !== next.length) return false;
  const left = [...current];
  for (const x of next) {
    const i = left.indexOf(x);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/**
 * A saved order brought up to date with what exists now: the saved items in
 * their saved order, then anything new in its default place relative to the
 * rest, and nothing that no longer exists. How the rail's order (item 89)
 * survives a new tab being added to Baton — Activity arrived after people had
 * already ordered theirs.
 */
export function reconcileOrder<T>(saved: readonly unknown[], current: readonly T[]): T[] {
  const kept = saved.filter((x, i): x is T => current.includes(x as T) && saved.indexOf(x) === i);
  const result = [...kept];
  current.forEach((item, i) => {
    if (result.includes(item)) return;
    // Just after whatever came before it by default, so a new tab lands near
    // its neighbours rather than always at the end.
    const before = current.slice(0, i).reverse().find((x) => result.includes(x));
    result.splice(before === undefined ? 0 : result.indexOf(before) + 1, 0, item);
  });
  return result;
}
