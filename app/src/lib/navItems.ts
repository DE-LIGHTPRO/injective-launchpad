/**
 * The primary destinations, declared once.
 *
 * There are three navigations on every page - the header nav, the phone menu behind the
 * header button, and the footer nav - and before this they were three hand-written lists
 * of the same six links. That is the shape of defect this codebase keeps finding: each
 * copy is locally correct, nothing errors when they disagree, and the one that drifts is
 * whichever a change forgets. A seventh destination added to the header would simply be
 * missing from a phone, which is the version nobody tests.
 *
 * `Risks` is last on purpose and present in all three: somebody looking for what can go
 * wrong should not have to go looking.
 */
export type NavItem = { href: string; label: string };

export const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/', label: 'Launches' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/claim', label: 'Claim' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/risks', label: 'Risks' },
] as const;

/**
 * The footer carries one more than the header does, because the header spends that room
 * on the Create button instead. It is the same destination either way.
 */
export const CREATE_NAV: NavItem = { href: '/create', label: 'Create a launch' };

/**
 * The footer's order, which is the header's with Create second - where it has always sat
 * in the footer, and the arrangement this derivation exists to preserve rather than
 * quietly restyle. Appending Create instead would have moved `Risks` off the end, which
 * is a decision about what a visitor sees and not a tidy-up.
 */
export const FOOTER_NAV: readonly NavItem[] = PRIMARY_NAV.flatMap((item, i) =>
  i === 0 ? [item, CREATE_NAV] : [item],
);
