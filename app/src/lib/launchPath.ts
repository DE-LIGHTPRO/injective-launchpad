import { symbolOf } from './chain.ts';
import type { Launch } from './chain.ts';

/**
 * The least a thing needs for a URL: which launch it is, and what it is called.
 *
 * Narrower than `Launch` on purpose. The board, the portfolio, the watchlist and the
 * claim page each carry their own row type, and widening every one of them to a full
 * `Launch` just to build a link would be the tail wagging the dog.
 */
export interface Linkable {
  id: number;
  denom: string;
}

/**
 * What a launch's URL looks like.
 *
 * `/launch/1` is a database row leaking onto the address bar. It tells a reader
 * nothing, it cannot be recognised when someone pastes it into a chat, and it says
 * the product thinks of a token as a record rather than as a token. Every comparable
 * launchpad puts an identity in the path. So: `/launch/INJINU`.
 *
 * THE ID DOES NOT GO AWAY, because a ticker is not unique. A tokenfactory denom is
 * `factory/<creator>/<SUBDENOM>`, so two creators can each launch `INJINU` and the
 * chain is perfectly happy. Where that happens the slug carries the id to separate
 * them (`/launch/INJINU-7`), and where it does not the slug is just the ticker. The
 * numeric form keeps resolving for ever, so links already shared do not rot; the page
 * redirects it to the canonical slug rather than serving the same launch at two URLs,
 * which splits search ranking and makes a shared link look unlike the one in the bar.
 *
 * AMBIGUITY IS DECIDED BY THE BOARD, NOT BY THE LAUNCH. A ticker that is unique today
 * stops being unique the moment someone copies it, so `launchPath` takes the other
 * launches it is competing with. A caller that does not have them says so by passing
 * nothing, and gets the always-unambiguous form.
 */

/** A subdenom is `[a-zA-Z0-9._-]`, all of which survive a URL path segment as is. */
const SUFFIXED = /^(.+)-([0-9]+)$/;

/**
 * The canonical path for a launch.
 *
 * `others` is every launch the slug has to be distinguishable from, usually the whole
 * board. Omitting it is not an error: it produces `SYMBOL-id`, which is correct
 * whatever else exists, just longer than it needs to be.
 */
export function launchPath(launch: Linkable, others?: Linkable[]): string {
  return pathForSlug(launchSlug(launch, others));
}

/** The URL for a slug already resolved. One place writes the base path. */
export function pathForSlug(slug: string): string {
  return `/launch/${slug}`;
}

export function launchSlug(launch: Linkable, others?: Linkable[]): string {
  const symbol = symbolOf(launch.denom);
  if (!others) return `${symbol}-${launch.id}`;
  const clashes = others.some(
    (o) => o.id !== launch.id && symbolOf(o.denom).toLowerCase() === symbol.toLowerCase(),
  );
  return clashes ? `${symbol}-${launch.id}` : symbol;
}

export type LaunchRef =
  | { kind: 'id'; id: number }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'symbol-id'; symbol: string; id: number };

/**
 * Read a path segment back.
 *
 * ORDER MATTERS AND THE WHOLE STRING WINS. A subdenom may itself contain a dash and
 * end in digits, so `MEME-2024` is a plausible TICKER as well as a plausible
 * `symbol-id` pair. The resolver below tries the literal symbol first and only falls
 * back to splitting the suffix, so a token actually called `MEME-2024` keeps its own
 * name and is not read as `MEME` number 2024.
 */
export function parseLaunchRef(slug: string): LaunchRef | null {
  const s = decodeURIComponent(slug ?? '').trim();
  if (!s) return null;
  if (/^[0-9]+$/.test(s)) {
    const id = Number(s);
    return Number.isSafeInteger(id) && id >= 0 ? { kind: 'id', id } : null;
  }
  return { kind: 'symbol', symbol: s };
}

export interface Resolution {
  /** The launch, when exactly one answers to the slug. */
  launch: Launch | null;
  /**
   * Several launches share this ticker and the slug did not say which.
   *
   * The page lists them rather than picking one. Picking the oldest would be the
   * obvious shortcut and would quietly send someone to a different token than the
   * one they were linked to, which on a launchpad is the worst available outcome.
   */
  candidates: Launch[];
  /**
   * The canonical slug, when the one used was not it.
   *
   * Drives a redirect, so `/launch/7` and `/launch/injinu` both end up at
   * `/launch/INJINU` rather than serving the same page at three addresses.
   */
  canonical: string | null;
}

/** Resolve a slug against the board. Pure, so it is testable without a chain. */
export function resolveLaunchSlug(slug: string, launches: Launch[]): Resolution {
  const none: Resolution = { launch: null, candidates: [], canonical: null };
  const ref = parseLaunchRef(slug);
  if (!ref) return none;

  const canonical = (l: Launch) => {
    const want = launchSlug(l, launches);
    return want === slug ? null : want;
  };

  if (ref.kind === 'id') {
    const found = launches.find((l) => l.id === ref.id) ?? null;
    return found ? { launch: found, candidates: [], canonical: canonical(found) } : none;
  }

  // The literal ticker first, so a token whose name ends in `-<digits>` wins its name.
  const lower = ref.symbol.toLowerCase();
  const named = launches.filter((l) => symbolOf(l.denom).toLowerCase() === lower);
  if (named.length === 1) {
    return { launch: named[0], candidates: [], canonical: canonical(named[0]) };
  }
  if (named.length > 1) {
    return { launch: null, candidates: named, canonical: null };
  }

  // Then `SYMBOL-id`. The id decides; the symbol must agree, so a stale link carrying
  // the right number and the wrong ticker is a miss rather than a silent swap.
  const m = SUFFIXED.exec(ref.symbol);
  if (m) {
    const id = Number(m[2]);
    const found = launches.find(
      (l) => l.id === id && symbolOf(l.denom).toLowerCase() === m[1].toLowerCase(),
    );
    if (found) return { launch: found, candidates: [], canonical: canonical(found) };
  }
  return none;
}
