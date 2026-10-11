/**
 * The product's name, in one place: Vetta, Italian for "summit".
 *
 * Every user-facing mention reads from here. Storage keys elsewhere (`injpad:watchlist`,
 * `injpad:upload:*`) and the Vercel project name deliberately do NOT: renaming them
 * would silently empty every user's watchlist and break the deploy script.
 */
export const BRAND_NAME = 'Vetta';
export const BRAND_TAGLINE = 'Fair launches on Injective';

/**
 * Where this site lives, as an absolute origin with no trailing slash.
 *
 * ONE COPY. It was written out three times — `layout.tsx`, `sitemap.ts` and, by
 * omission, `ShareRow`, which had no origin at all and fell back to a relative path.
 * Three copies of a default is three chances for a deployment to disagree with
 * itself about its own address.
 *
 * IT MUST NOT BE DERIVED FROM `window.location`. `ShareRow` did that, so the server
 * rendered the X intent with `url=/launch/VETTA` and the client replaced it after
 * hydration. That is a hydration mismatch React reports, and before hydration (or to
 * a crawler) the share link pointed nowhere. A build-time constant is the same value
 * on both sides, which is the whole requirement.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://injpad.vercel.app'
).replace(/\/+$/, '');

/** An absolute URL for a path on this site. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
