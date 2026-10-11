import type { Metadata } from 'next';
import { DemoBanner } from '@/components/DemoBanner';
import { Portfolio } from '@/components/Portfolio';
import { loadRows, toRows } from '@/lib/boardRows';
import { isDevBuild } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Portfolio', robots: { index: false } };

export default async function PortfolioPage() {
  const { rows, error, errorDetail } = await loadRows();
  return (
    <>
      <DemoBanner />
      <h1>Portfolio</h1>
      <p className="sub">What your connected wallet holds across launches.</p>
      <div style={{ marginTop: 'var(--space-5)' }}>
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
