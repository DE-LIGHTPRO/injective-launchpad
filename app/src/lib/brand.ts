/**
 * The product's name, in one place.
 *
 * A rename is pending (candidates: Crestline, Plateau). Every user-facing mention reads
 * from here, so the rename is this one line. Storage keys elsewhere (`injpad:watchlist`)
 * deliberately do NOT read from it: renaming them would silently empty every user's
 * watchlist.
 */
export const BRAND_NAME = 'inj·pad';
export const BRAND_TAGLINE = 'Fair launches on Injective';
