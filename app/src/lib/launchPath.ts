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
 *
 * THE PLAIN LINK BELONGS TO THE FIRST LAUNCH THAT USED THE TICKER, AND CANNOT BE
 * TAKEN AWAY FROM IT. Audit F-17. Both halves of this file used to treat a clash as
 * symmetrical: every launch sharing a ticker got the suffix, and a plain `/launch/
 * INJINU` resolved to nobody and rendered a chooser. The reasoning written here was
 * that "picking the oldest would quietly send someone to a different token than the
 * one they were linked to, which on a launchpad is the worst available outcome", and
 * it had the direction exactly backwards:
 *
 *  - A PLAIN LINK CAN ONLY EVER HAVE BEEN MINTED FOR THE EARLIEST LAUNCH. It is
 *    handed out while the ticker is unique, and ids are assigned in order, so the
 *    launch it meant at the moment it was shared is the one with the lowest id. The
 *    oldest is not a guess at what the reader wanted; it is the only thing that link
 *    has ever pointed at. Resolving it to the oldest is what keeps a promise.
 *  - SO THE CHOOSER BROKE EVERY LINK ALREADY SHARED, and anyone could do it to
 *    anyone, for the price of one launch. Post a copy of a popular ticker and every
 *    link that creator has ever posted stops arriving.
 *  - AND THE CHOOSER WAS NOT THE SAFE OPTION IT LOOKED LIKE. It offered two entries
 *    with the same ticker and nothing else to tell them apart, which is a coin flip
 *    presented as a choice, and a coin flip the copycat gets to enter. It converted
 *    griefing into roughly half the traffic.
 *
 * What the chooser was genuinely carrying is the warning, not the choice, and the
 * warning is better where it costs nothing: `Resolution.sameTicker` reports the other
 * launches using this ticker whichever one resolved, so the page can say so on the
 * original AND on the copy. Telling a reader on `/launch/INJINU-40` that this is not
 * the first token called INJINU is the protection; making them pick blindly was not.
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
  /*
   * `o.id < launch.id`, not `o.id !== launch.id`. Only a launch that came FIRST
   * displaces this one from the plain form, which is what makes the plain form
   * permanent for whoever got there first. Strictly less than also excludes the
   * launch itself without a separate identity check, and tolerates a caller that
   * passes a board this launch is not in yet.
   */
  const lower = symbol.toLowerCase();
  const earlier = others.some((o) => o.id < launch.id && symbolOf(o.denom).toLowerCase() === lower);
  return earlier ? `${symbol}-${launch.id}` : symbol;
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
  /** The launch the slug names, or null when nothing answers to it. */
  launch: Launch | null;
  /**
   * The OTHER launches using this ticker. Empty for all but a copied name.
   *
   * Not a choice to be made, which is what it was before: the slug already decided
   * which launch this is. It is what the page needs to tell a reader that the ticker
   * on their screen is not unique, which it must do on the original and on the copy,
   * because either one can be the page somebody arrived at from a link.
   */
  sameTicker: Launch[];
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
  const none: Resolution = { launch: null, sameTicker: [], canonical: null };
  const ref = parseLaunchRef(slug);
  if (!ref) return none;

  const canonical = (l: Launch) => {
    const want = launchSlug(l, launches);
    return want === slug ? null : want;
  };
  /* Computed for every resolved launch, not only the ambiguous entry point, because
   * `/launch/40` and `/launch/INJINU-40` land on the copy without passing through the
   * plain name at all, and that is the reader most in need of being told. */
  const sharing = (l: Launch) => {
    const sym = symbolOf(l.denom).toLowerCase();
    return launches.filter((o) => o.id !== l.id && symbolOf(o.denom).toLowerCase() === sym);
  };
  const hit = (l: Launch): Resolution => ({
    launch: l,
    sameTicker: sharing(l),
    canonical: canonical(l),
  });

  if (ref.kind === 'id') {
    const found = launches.find((l) => l.id === ref.id);
    return found ? hit(found) : none;
  }

  // The literal ticker first, so a token whose name ends in `-<digits>` wins its name.
  const lower = ref.symbol.toLowerCase();
  const named = launches.filter((l) => symbolOf(l.denom).toLowerCase() === lower);
  if (named.length > 0) {
    /*
     * The earliest, which is the only launch this link has ever named. See the note
     * at the top of the file: a plain ticker is handed out while it is unique, so
     * resolving it to the lowest id is not choosing between two tokens, it is
     * declining to let the second one take the first one's address. `reduce` rather
     * than a sort, because the board's order is the contract's and is not ours to
     * assume.
     */
    return hit(named.reduce((a, b) => (a.id <= b.id ? a : b)));
  }

  // Then `SYMBOL-id`. The id decides; the symbol must agree, so a stale link carrying
  // the right number and the wrong ticker is a miss rather than a silent swap.
  const m = SUFFIXED.exec(ref.symbol);
  if (m) {
    const id = Number(m[2]);
    const found = launches.find(
      (l) => l.id === id && symbolOf(l.denom).toLowerCase() === m[1].toLowerCase(),
    );
    if (found) return hit(found);
  }
  return none;
}
