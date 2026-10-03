'use client';

import { useEffect } from 'react';

/**
 * Escape closes a popover, and a click outside it does too.
 *
 * A menu that can only be dismissed by clicking the control that opened it is a
 * trap for anyone navigating by keyboard, and it is the one interaction people
 * try first. Lightweight popovers use this; a real dialog needs focus trapping
 * and a portal, which is a different component.
 */
export function useDismissOnEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // Anything inside the menu or its trigger is not an outside click.
      if (t?.closest('.wallet')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);
}
