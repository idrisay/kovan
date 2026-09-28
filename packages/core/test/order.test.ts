import { describe, expect, it } from 'vitest';
import { isReordering, moveBy, moveItem, reconcileOrder } from '../src/order';

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('puts the item before or after the target', () => {
    expect(moveItem(list, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveItem(list, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(list, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves the list alone for itself or anything unknown', () => {
    expect(moveItem(list, 'b', 'b', true)).toEqual(list);
    expect(moveItem(list, 'x', 'b', true)).toEqual(list);
    expect(moveItem(list, 'b', 'x', true)).toEqual(list);
  });

  it('does not change the list it was given', () => {
    const copy = [...list];
    moveItem(copy, 'd', 'a', false);
    expect(copy).toEqual(list);
  });
});

describe('moveBy', () => {
  it('moves one place, and stops at either end', () => {
    expect(moveBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('isReordering', () => {
  it('accepts the same items in any order', () => {
    expect(isReordering(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isReordering(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('refuses an added, dropped or swapped-out item', () => {
    expect(isReordering(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(isReordering(['a', 'b'], ['a'])).toBe(false);
    expect(isReordering(['a', 'b'], ['a', 'x'])).toBe(false);
    expect(isReordering(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(false);
  });
});

// Item 89: the rail's saved order against the tabs that exist now.
describe('reconcileOrder', () => {
  const tabs = ['pulls', 'tickets', 'sentry', 'activity', 'workspace', 'sessions', 'agents'];

  it('keeps a saved order', () => {
    const saved = ['sessions', 'pulls', 'tickets', 'sentry', 'activity', 'workspace', 'agents'];
    expect(reconcileOrder(saved, tabs)).toEqual(saved);
  });

  it('puts a new tab after its default neighbour, not at the end', () => {
    const saved = ['sessions', 'pulls', 'tickets', 'sentry', 'workspace', 'agents'];
    expect(reconcileOrder(saved, tabs)).toEqual(['sessions', 'pulls', 'tickets', 'sentry', 'activity', 'workspace', 'agents']);
  });

  it('drops what no longer exists, duplicates and junk', () => {
    expect(reconcileOrder(['gone', 'agents', 42, 'agents', 'pulls'], ['pulls', 'agents'])).toEqual(['agents', 'pulls']);
  });

  it('falls back to the default for nothing saved', () => {
    expect(reconcileOrder([], tabs)).toEqual(tabs);
  });
});
