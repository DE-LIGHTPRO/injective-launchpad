import type { Metadata } from 'next';
import { DemoBanner } from '@/components/DemoBanner';
import { Portfolio } from '@/components/Portfolio';
import { UnreadableNotice } from '@/components/UnreadableNotice';
import { loadRows, toRows } from '@/lib/boardRows';
import { isDevBuild } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Portfolio', robots: { index: false } };

export default async function PortfolioPage() {
  const { rows, error, errorDetail, unreadable } = await loadRows();
  return (
    <>
      <DemoBanner />
      <h1>Portfolio</h1>
      <p className="sub">What your connected wallet holds across launches.</p>
      <div style={{ marginTop: 'var(--space-5)' }}>
        {/*
            Above the holdings, because this page answers "what do I own" and a curve
            that would not answer makes that answer incomplete in a way no row can show:
            a position in an unreadable launch is absent here, not zero.
          */}
        <UnreadableNotice unreadable={unreadable} />
        {error ? (
          <div className="empty">
            <p className="danger-text">{error}</p>
            {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
          </div>
        ) : (
          <Portfolio rows={toRows(rows)} />
        )}
      </div>
    </>
  );
}
