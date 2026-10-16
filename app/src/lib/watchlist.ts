/**
 * A per-browser watchlist of launch ids.
 *
 * Browser storage on purpose: a watchlist is a personal convenience, and putting it on
 * a server would mean accounts, which a wallet-first product should not need for this.
 * Every access is guarded, because storage can be absent or throw (private windows,
 * blocked site data), and the page must work identically without it.
 */

import { getFactoryAddress } from './config.ts';

/**
 * SCOPED TO THE FACTORY, because a launch id means nothing without one.
 *
 * It was `injpad:watchlist:v1` flat, and mainnet is a flip of `NEXT_PUBLIC_NETWORK` on
 * the same origin (see `config.ts`), so on launch day every visitor's browser would
 * still have held a list of TESTNET ids and the page would have resolved them against
 * mainnet launches numbered the same. Ids restart at 1 under a new factory, so starred
 * testnet launch 1 becomes whatever mainnet launch 1 happens to be: a list the user
 * never curated, presented under the heading "Launches you have starred", on a
 * launchpad where "I looked at this one already" is the whole value of the feature.
 *
 * The factory rather than the network name, because a redeploy on the SAME network
 * renumbers just as completely, and that has happened on this project more than once.
 *
 * NOT MIGRATED. There is no honest way to decide which factory an unscoped list
 * belonged to, and guessing "the current one" is precisely the bug above: an old
 * visitor's testnet list would be adopted into the mainnet scope. The legacy key is
 * removed instead, so it cannot be re-adopted later by someone who finds it.
 */
const LEGACY_KEY = 'injpad:watchlist:v1';

function watchKey(): string {
  return `${LEGACY_KEY}:${getFactoryAddress() || 'none'}`;
}

const EVENT = 'injpad:watchlist';

export function parseWatchlist(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    // Ids only, deduplicated, and capped so a corrupted value cannot grow forever.
    return [...new Set(v.filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500) as number[];
  } catch {
    return [];
  }
}

export function readWatchlist(): number[] {
  try {
    window.localStorage.removeItem(LEGACY_KEY);
    return parseWatchlist(window.localStorage.getItem(watchKey()));
  } catch {
    return [];
  }
}

export function toggleWatch(id: number): boolean {
  const list = readWatchlist();
  const on = !list.includes(id);
  const next = on ? [id, ...list] : list.filter((x) => x !== id);
  try {
    window.localStorage.setItem(watchKey(), JSON.stringify(next));
  } catch {
    /* storage unavailable: the toggle still reflects in this tab via the event */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
  return on;
}

/** Calls back when this tab or another tab changes the list. Returns an unsubscribe. */
export function onWatchlistChange(cb: () => void): () => void {
  const storage = (e: StorageEvent) => {
    if (e.key === watchKey()) cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', storage);
  };
}
