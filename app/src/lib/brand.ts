/**
 * The product's name, in one place: Vetta, Italian for "summit".
 *
 * Every user-facing mention reads from here. Storage keys elsewhere (`injpad:watchlist`,
 * `injpad:upload:*`) and the Vercel project name deliberately do NOT: renaming them
 * would silently empty every user's watchlist and break the deploy script.
 */
export const BRAND_NAME = 'Vetta';
export const BRAND_TAGLINE = 'Fair launches on Injective';
