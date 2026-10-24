'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { ALL_NAV, isNavCurrent } from '@/lib/navItems';
import { useDismissOnEscape } from '@/lib/useDismissOnEscape';

/**
 * The primary navigation on a phone, which did not exist.
 *
 * `@media (max-width: 720px) { .top-nav { display: none } }` was one uncommented line
 * with nothing in its place, so on every phone and portrait tablet the header offered
 * the brand, Create and Connect wallet, and the six destinations behind that nav -
 * Launches, Watchlist, Portfolio, Claim, Analytics, Risks - were reachable only by
 * scrolling to the footer, 2800px down on the home page. `display: none` also removes
 * a node from the accessibility tree, so a screen-reader user on a phone had no primary
 * nav at all, not a hidden one.
 *
 * Measured on the running app at 375px before this: the header's own links reported
 * 0x0, and the nine controls still under the WCAG 2.5.8 floor were all in the footer -
 * which is the only reason the footer was carrying navigation in the first place.
 *
 * The links come from `ALL_NAV` rather than being written out again here, because a
 * phone menu that silently lacks a destination the header has is the exact failure this
 * component exists to fix.
 *
 * `ALL_NAV` and not `PRIMARY_NAV`, which is the seventh destination: Create. Audit
 * F-14/F-15 sheds the header's Create button below 360px, where a connected wallet, the
 * brand, this button and that one do not fit a 320px screen, so this menu is now the
 * only place it is reachable at that width. Taking the list that already includes it is
 * the fix; adding a seventh row by hand here would be the defect the list exists against.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const pathname = usePathname();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstLinkRef = useRef<HTMLAnchorElement | null>(null);
  // Distinguishes a close from the first render, which look identical from `open` alone.
  const everOpened = useRef(false);

  useDismissOnEscape(open, () => setOpen(false), '.mobile-nav');

  /*
   * Close on navigation. A client-side route change keeps this component mounted, so
   * without this the menu stays open over the page it just navigated to and the user
   * has to dismiss the thing that appeared to do nothing.
   */
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  /*
   * Focus moves in, and comes back out to the trigger.
   *
   * Both halves measured rather than assumed. Opening a menu and leaving focus on the
   * body means a keyboard user has to tab through the whole header to reach what they
   * just opened. And the way back out cannot live only in the trigger's own handler:
   * Escape and an outside click both close this from `useDismissOnEscape`, and the first
   * version of that path called `setOpen(false)` directly, so Escape closed the menu and
   * left focus on the body - confirmed on the running page, `document.activeElement` was
   * neither the trigger nor anything in the header.
   *
   * `everOpened` is what separates a close from the FIRST RENDER, which are the same
   * thing as far as `open === false` can tell. Without it this restores focus on mount
   * and steals it from the top of the document on every page load; that is exactly the
   * defect this pattern had in `ConnectWallet`, found by measuring there.
   */
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      firstLinkRef.current?.focus();
      return;
    }
    if (!everOpened.current) return;
    everOpened.current = false;
    /*
     * Only when focus was lost. Unmounting the focused link drops the active element to
     * the body, which is the case to restore from. If it is anywhere else the user has
     * clicked something themselves and pulling them back would be its own bug.
     */
    const a = document.activeElement;
    if (!a || a === document.body) triggerRef.current?.focus();
  }, [open]);

  return (
    <div className="mobile-nav">
      <button
        ref={triggerRef}
        type="button"
        className="mobile-nav-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? 'Close menu' : 'Open menu'}
      >
        {/*
         * A stroke icon rather than a glyph: an emoji or a literal "≡" renders
         * differently per platform, cannot take the surrounding colour, and does not
         * sit on the same baseline as the controls beside it.
         */}
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          {open ? (
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
            </g>
          ) : (
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="2.5" y1="5" x2="15.5" y2="5" />
              <line x1="2.5" y1="9" x2="15.5" y2="9" />
              <line x1="2.5" y1="13" x2="15.5" y2="13" />
            </g>
          )}
        </svg>
      </button>

      {open && (
        <nav className="mobile-nav-menu" id={menuId} aria-label="Primary">
          {ALL_NAV.map((item, i) => (
            <Link
              key={item.href}
              href={item.href}
              ref={i === 0 ? firstLinkRef : undefined}
              aria-current={isNavCurrent(pathname, item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
