'use client';

import { useEffect, useState } from 'react';
import { onWatchlistChange, readWatchlist, toggleWatch } from '@/lib/watchlist';

/** A star that adds a launch to this browser's watchlist. */
export function WatchButton({ id, symbol }: { id: number; symbol: string }) {
  // Starts false on the server and the first client render, then syncs, so hydration
  // never disagrees with markup the server could not have known.
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(readWatchlist().includes(id));
    sync();
    return onWatchlistChange(sync);
  }, [id]);

  return (
    <button
      type="button"
      className="watch-btn"
      aria-pressed={on}
      aria-label={on ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      title={on ? 'Watching' : 'Watch'}
      onClick={(e) => {
        // Inside a card that is itself a link: starring must not navigate.
        e.preventDefault();
        e.stopPropagation();
        setOn(toggleWatch(id));
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}
