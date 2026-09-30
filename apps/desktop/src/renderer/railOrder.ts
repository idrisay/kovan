/**
 * The order of the rail's tabs (item 89): drag an icon up or down, or ⌥↑ / ⌥↓
 * on a focused one. A per-window visual preference, so localStorage — wrapped
 * in try, and the default order when it isn't there. Settings stays pinned at
 * the bottom and isn't part of it.
 */

import { useCallback, useState } from 'react';
import { reconcileOrder } from '@kovan/core';

const KEY = 'kovan.rail-order';

function load<T extends string>(ids: readonly T[]): T[] {
  try {
    const raw = localStorage.getItem(KEY);
    const saved: unknown = raw ? JSON.parse(raw) : [];
    return reconcileOrder(Array.isArray(saved) ? saved : [], ids);
  } catch {
    return [...ids];
  }
}

export function useRailOrder<T extends string>(ids: readonly T[]): [T[], (next: T[]) => void] {
  const [order, setOrder] = useState<T[]>(() => load(ids));
  const save = useCallback((next: T[]) => {
    setOrder(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode or a full store: the order just won't be remembered.
    }
  }, []);
  return [order, save];
}
