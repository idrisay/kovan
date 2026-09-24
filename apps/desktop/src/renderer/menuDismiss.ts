import { useEffect } from 'react';

const OPENED = 'baton:menu-opened';

/**
 * Closes a drop-down on any click outside it, on Escape, and when another
 * menu opens. Every menu's own button stops its click from reaching the
 * document (or it would close itself as it opened), which also meant a
 * second menu opening never told the first to close: two pickers could sit
 * open on top of each other. Each open menu now announces itself instead.
 */
export function useMenuDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const me = Symbol('menu');
    window.dispatchEvent(new CustomEvent(OPENED, { detail: me }));
    const onOther = (event: Event) => { if ((event as CustomEvent<symbol>).detail !== me) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPENED, onOther);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPENED, onOther);
    };
    // `close` is a fresh arrow on every render; the menu only cares whether it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
