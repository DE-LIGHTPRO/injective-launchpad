'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PRIMARY_NAV, isNavCurrent } from '@/lib/navItems';

/**
 * The header navigation, which until now could not say where you were.
 *
 * MEASURED ON THE RUNNING APP: all six links resolved to `color: rgb(161,166,176)` and
 * `background: rgba(0,0,0,0)` on `/`, and none of them carried `aria-current`. So the
 * page a visitor is reading looked exactly like the five they are not, on every route,
 * and a screen reader was told the same thing - there was no current destination in the
 * primary navigation at all.
 *
 * It is a client component only because `usePathname` is. The layout that renders it
 * stays a server component, and the links themselves are still `PRIMARY_NAV`, so this
 * does not become a fourth hand-written copy of the one list.
 */
export function PrimaryNav() {
  const pathname = usePathname();

  return (
    <nav className="top-nav" aria-label="Primary">
      {PRIMARY_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isNavCurrent(pathname, item.href) ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
