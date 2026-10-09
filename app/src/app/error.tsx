'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * What a render throw looks like instead of a blank page.
 *
 * React unmounts the whole tree when a component throws, so without this one bad value
 * anywhere on a launch page leaves white. There was no boundary at all, which on a
 * surface where people sign transactions is the version that frightens them most: the
 * page they were trading on simply disappears.
 *
 * THE FIRST LINE IS ABOUT THEIR MONEY, and that is deliberate. Whatever went wrong
 * here went wrong while rendering, after any signing had already resolved one way or
 * the other, so this page can say plainly that nothing was sent. That is the first
 * thing anyone wants to know and the last thing a generic error page tells them.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged rather than shown. The message is written for a developer and reads as a
    // crash; the digest is what ties this to a server log if one is ever added.
    console.error('render error', error);
  }, [error]);

  return (
    <div className="card" style={{ marginTop: 'var(--space-6)' }}>
      <h1>This page stopped rendering</h1>
      <p className="note">
        <strong>Nothing was signed and no transaction was sent.</strong> This is a display
        fault in the page, not an action on the chain. Any launch or trade you completed
        before this is unaffected.
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="nav-create">
          Back to launches
        </Link>
      </div>
      {error.digest && <p className="note mono">Reference: {error.digest}</p>}
    </div>
  );
}
