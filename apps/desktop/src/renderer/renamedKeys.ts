/**
 * Kovan was called Baton until 2026-09-30, and the layout it remembers (sidebar
 * width, panes, folded cards…) was stored under "baton." keys. Carried across
 * once, here, before any module reads its key: `main.tsx` imports this first.
 */
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('baton.')) continue;
    const renamed = `kovan.${key.slice('baton.'.length)}`;
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(renamed) === null) localStorage.setItem(renamed, value);
    localStorage.removeItem(key);
  }
} catch {
  // Storage unavailable: the layout starts from its defaults.
}

export {};
