import type { Metadata } from 'next';
import { DemoBanner } from '@/components/DemoBanner';
import { WatchlistBoard } from '@/components/WatchlistBoard';
import { UnreadableNotice } from '@/components/UnreadableNotice';
import { loadRows, toRows } from '@/lib/boardRows';
import { isDevBuild } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Watchlist', robots: { index: false } };

export default async function WatchlistPage() {
  const { rows, error, errorDetail, unreadable } = await loadRows();
  return (
    <>
      <DemoBanner />
      <h1>Watchlist</h1>
      <p className="sub">Launches you have starred, in this browser.</p>
      <div style={{ marginTop: 'var(--space-5)' }}>
        {/*
            The watchlist is the page where this matters most and shows least: a starred
            launch whose curve did not answer is indistinguishable from one that was
            never starred, because the star lives in this browser and the row does not.
          */}
        <UnreadableNotice unreadable={unreadable} />
        {error ? (
          <div className="empty">
            <p className="danger-text">{error}</p>
            {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
          </div>
        ) : (
          <WatchlistBoard rows={toRows(rows)} />
        )}
      </div>
    </>
  );
}
