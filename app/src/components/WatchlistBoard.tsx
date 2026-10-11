'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LaunchList, type LaunchRow } from './LaunchList';
import { onWatchlistChange, readWatchlist } from '@/lib/watchlist';

/** The board, filtered to what this browser is watching. */
export function WatchlistBoard({ rows }: { rows: LaunchRow[] }) {
  const [ids, setIds] = useState<number[] | null>(null);
  useEffect(() => {
    const sync = () => setIds(readWatchlist());
    sync();
    return onWatchlistChange(sync);
  }, []);

  // Not read yet: render nothing rather than flashing "empty" before storage answers.
  if (ids === null) return null;
  const watched = rows.filter((r) => ids.includes(r.id));
  if (watched.length === 0) {
    return (
      <div className="empty-hero empty-hero-compact">
        <h2>Nothing on your watchlist</h2>
        <p className="note">
          Star a launch from the board or its page to keep it here. The list lives in this
          browser only; nothing is sent anywhere.
        </p>
        <Link href="/" className="go empty-cta">
          Browse launches
        </Link>
      </div>
    );
  }
  return <LaunchList rows={watched} />;
}
