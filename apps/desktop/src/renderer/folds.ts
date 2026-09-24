import { useCallback, useEffect, useState } from 'react';

function readList(storageKey: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Whether something that folds (a description, a summary, a review) is folded,
 * remembered per thing — per PR, ticket or card — not once for all: folding
 * one long review shouldn't hide the next one you haven't read yet. Kept as a
 * list of the folded keys, newest last and capped, so it can't grow forever.
 */
export function useFold(key: string, storageKey = 'baton.folded-cards'): [boolean, () => void] {
  const [folded, setFolded] = useState(() => readList(storageKey).includes(key));
  useEffect(() => setFolded(readList(storageKey).includes(key)), [key, storageKey]);
  const toggle = useCallback(() => {
    setFolded((was) => {
      const next = !was;
      try {
        const list = readList(storageKey).filter((k) => k !== key);
        if (next) list.push(key);
        localStorage.setItem(storageKey, JSON.stringify(list.slice(-300)));
      } catch { /* the fold still works for this visit */ }
      return next;
    });
  }, [key, storageKey]);
  return [folded, toggle];
}
