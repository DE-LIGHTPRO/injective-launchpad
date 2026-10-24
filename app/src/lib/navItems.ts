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
 * The header spends a button on this destination instead of a nav slot, which is why it
 * is declared apart from the six. It is the same destination either way.
 */
export const CREATE_NAV: NavItem = { href: '/create', label: 'Create a launch' };

/**
 * Every destination, in the footer's order: the header's six with Create second - where
 * it has always sat in the footer, and the arrangement this derivation exists to preserve
 * rather than quietly restyle. Appending Create instead would have moved `Risks` off the
 * end, which is a decision about what a visitor sees and not a tidy-up.
 *
 * THE PHONE MENU READS THIS TOO, AND DID NOT USED TO. Audit F-14/F-15. It rendered
 * `PRIMARY_NAV`, so Create was in the header and in the footer and nowhere else - fine
 * while the header carried the button at every width, and the header cannot: below 360px
 * the connected cluster, the brand, the menu and a Create button do not fit, and Create
 * is the one of the four that something else can carry. A destination the header sheds
 * has to land somewhere, and this was called `FOOTER_NAV` when only the footer took it.
 */
export const ALL_NAV: readonly NavItem[] = PRIMARY_NAV.flatMap((item, i) =>
  i === 0 ? [item, CREATE_NAV] : [item],
);

/**
 * Whether a nav destination is the page currently open.
 *
 * ONE RESOLVER, for the same reason the list above is one list. The phone menu already
 * wrote `pathname === item.href` inline and the header nav had nothing at all, so on
 * every page the desktop navigation gave no sign of where the visitor was - the six
 * links rendered identically on `/`, `/portfolio` and `/risks`. That is this file's own
 * defect one level down: the decision existed in one of the two copies.
 *
 * Exact match, OR a prefix that ends on a SEGMENT BOUNDARY. A sub-route like
 * `/portfolio/<addr>` is still Portfolio, which exact matching alone would miss, and the
 * trailing slash is what stops `/portfolios` matching `/portfolio` as well.
 *
 * `/` needs no special case, and the version of this that had one is worth recording
 * because it read as the load-bearing line. The worry is real - `/` is a prefix of every
 * path, so a bare `startsWith` would light up Launches on all six pages - but the
 * boundary already answers it: for `/`, the prefix tested is `//`, and no path begins
 * with that. A mutation that deleted the special case passed every assertion, which is
 * how a line that does nothing gets found.
 */
export function isNavCurrent(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
