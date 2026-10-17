'use client';

import { useEffect } from 'react';

/**
 * Escape closes a popover, and a click outside it does too.
 *
 * A menu that can only be dismissed by clicking the control that opened it is a
 * trap for anyone navigating by keyboard, and it is the one interaction people
 * try first. Lightweight popovers use this; a real dialog needs focus trapping
 * and a portal, which is a different component.
 *
 * `within` is the selector for the popover AND its trigger, and it is required
 * rather than defaulted. It used to be the literal `.wallet`, which was correct
 * for the only caller and silently wrong for the next one: this fires on
 * `mousedown`, which precedes `click`, so a second popover would have had every
 * click inside it read as an outside click, closed before the `click` landed,
 * and its links would simply not navigate. A default would have carried that
 * bug into the new caller without a word.
 */
export function useDismissOnEscape(open: boolean, close: () => void, within: string): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // Anything inside the menu or its trigger is not an outside click.
      if (t?.closest(within)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close, within]);
}
