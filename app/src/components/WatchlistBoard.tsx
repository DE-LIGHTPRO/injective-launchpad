'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LaunchList, type LaunchRow } from './LaunchList';
import { onWatchlistChange, readWatchlist } from '@/lib/watchlist';
import { EmptyState } from './EmptyState';
import { MarkStar } from './EmptyMark';

/** The board, filtered to what this browser is watching. */
export function WatchlistBoard({ rows }: { rows: LaunchRow[] }) {
  const [ids, setIds] = useState<number[] | null>(null);
  useEffect(() => {
    const sync = () => setIds(readWatchlist());
    sync();
    return onWatchlistChange(sync);
  }, []);

  /*
   * NOT READ YET, AND SAYING SO. Audit F-13.
   *
   * This used to `return null`, with the comment "render nothing rather than flashing
   * 'empty' before storage answers". It was right about the hazard and wrong about the
   * remedy: flashing "Nothing on your watchlist" would be a false statement, and
   * rendering nothing at all is the same false statement with the words taken out. A
   * reader cannot tell a list that is still coming from a list that is not there.
   *
   * It is not a brief gap either, and the server render is why it cannot be: the list
   * lives in this browser, so no amount of server work can ever put it in the HTML.
   * Measured on the dev build, `/watchlist` arrives as a heading and a subtitle and
   * nothing else, every time, and stays that way until the page's JavaScript has run.
   *
   * A line that says it is loading is distinguishable from both the empty state and
   * the list, which is the whole requirement. Text rather than a shimmer deliberately,
   * see the note where `.skeleton` used to be in `globals.css`. Styled to match the
   * same state on the Portfolio page, because two sibling pages answering "not read
   * yet" differently is the drift that makes an interface read as unconsidered.
   */
  if (ids === null) {
    return (
      <p className="note" style={{ marginTop: 'var(--space-4)' }}>
        Loading your watchlist&hellip;
      </p>
    );
  }
  const watched = rows.filter((r) => ids.includes(r.id));
  if (watched.length === 0) {
    return (
      <EmptyState
        mark={<MarkStar />}
        title="Nothing on your watchlist"
        action={
          <Link href="/" className="go">
            Browse launches
          </Link>
        }
      >
        Star a launch from the board or its page to keep it here. The list lives in this
        browser only; nothing is sent anywhere.
      </EmptyState>
    );
  }
  return <LaunchList rows={watched} />;
}
