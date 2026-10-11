import type { Metadata } from 'next';
import { DemoBanner } from '@/components/DemoBanner';
import { WatchlistBoard } from '@/components/WatchlistBoard';
import { loadRows, toRow } from '@/lib/boardRows';
import { isDevBuild } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Watchlist', robots: { index: false } };

export default async function WatchlistPage() {
  const { rows, error, errorDetail } = await loadRows();
  return (
    <>
      <DemoBanner />
      <h1>Watchlist</h1>
      <p className="sub">Launches you have starred, in this browser.</p>
      <div style={{ marginTop: 'var(--space-5)' }}>
        {error ? (
          <div className="empty">
            <p className="danger-text">{error}</p>
            {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
          </div>
        ) : (
          <WatchlistBoard rows={rows.map(toRow)} />
        )}
      </div>
    </>
  );
}
