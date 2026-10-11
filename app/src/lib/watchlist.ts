/**
 * A per-browser watchlist of launch ids.
 *
 * Browser storage on purpose: a watchlist is a personal convenience, and putting it on
 * a server would mean accounts, which a wallet-first product should not need for this.
 * Every access is guarded, because storage can be absent or throw (private windows,
 * blocked site data), and the page must work identically without it.
 */

const KEY = 'injpad:watchlist:v1';
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
    return parseWatchlist(window.localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function toggleWatch(id: number): boolean {
  const list = readWatchlist();
  const on = !list.includes(id);
  const next = on ? [id, ...list] : list.filter((x) => x !== id);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the toggle still reflects in this tab via the event */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
  return on;
}

/** Calls back when this tab or another tab changes the list. Returns an unsubscribe. */
export function onWatchlistChange(cb: () => void): () => void {
  const storage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', storage);
  };
}
