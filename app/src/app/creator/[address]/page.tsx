import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DemoBanner } from '@/components/DemoBanner';
import { ArrowLeftIcon } from '@/components/Icons';
import { CopyButton } from '@/components/CopyButton';
import { LaunchList } from '@/components/LaunchList';
import { loadRows, toRow } from '@/lib/boardRows';
import { boardTotals, compact } from '@/lib/boardMetrics';
import { denomLabel } from '@/lib/chain';
import { addressName as nameFor } from '@/lib/addressName';
import { NETWORK, isDevBuild } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Injective bech32 account or contract address. Anything else is a 404, not a query. */
const ADDRESS = /^inj1[02-9ac-hj-np-z]{38,58}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  return { title: ADDRESS.test(address) ? `Creator ${nameFor(address)}` : 'Creator' };
}

/**
 * Everything one address has launched, and what it has been paid.
 *
 * A creator's history is the strongest signal a buyer has that this platform can
 * show without an indexer: someone with three launches that graduated is a different
 * proposition from someone whose last five died at 2%. pump.fun and nearly.trade both
 * link creator names to a profile for this reason.
 */
export default async function CreatorPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  // Demo creators are not bech32 (they spell out "demo"), so the demo is let through.
  if (!ADDRESS.test(address) && !address.startsWith('inj1demo')) notFound();

  const { rows, error, errorDetail } = await loadRows();
  const mine = rows.filter((r) => r.launch.creator === address);
  const t = boardTotals(
    mine.map((r) => ({
      raised: r.raised,
      feesAccrued: r.feesAccrued,
      graduated: r.graduated,
      creatorPaid: r.creatorPaid,
    })),
  );
  // Summed only when every launch shares one quote; otherwise the units differ.
  const quotes = new Set(mine.map((r) => r.quoteDenom));
  const one = quotes.size === 1 ? mine[0] : null;

  return (
    <>
      <DemoBanner />
      <p className="note" style={{ marginBottom: 'var(--space-4)' }}>
        <Link href="/" className="back-link">
          <ArrowLeftIcon size={14} /> All launches
        </Link>
      </p>
      <h1>{nameFor(address)}</h1>
      <p className="sub mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
        {address} <CopyButton value={address} label="Copy" />{' '}
        <a href={`${NETWORK.explorer}/account/${address}`} target="_blank" rel="noopener noreferrer">
          explorer
        </a>
      </p>

      {error ? (
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p className="danger-text">{error}</p>
          {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
        </div>
      ) : (
        <>
          <dl className="stats" style={{ marginTop: 'var(--space-5)' }}>
            <div className="stat">
              <dt className="k">Launches</dt>
              <dd className="v">{t.launches}</dd>
            </div>
            <div className="stat">
              <dt className="k">Graduated</dt>
              <dd className="v">{t.graduated}</dd>
            </div>
            <div className="stat">
              <dt className="k">Fees paid out</dt>
              <dd className="v">
                {one ? `${compact(t.paidToCreators, one.quoteDecimals)} ${denomLabel(one.quoteDenom)}` : '·'}
              </dd>
            </div>
            <div className="stat">
              <dt className="k">Fees unclaimed</dt>
              <dd className="v">
                {one ? `${compact(t.feesAccrued, one.quoteDecimals, 4)} ${denomLabel(one.quoteDenom)}` : '·'}
              </dd>
            </div>
          </dl>
          <p className="note" style={{ marginTop: 'var(--space-3)' }}>
            Names are generated from the address and are not chosen or verified.
          </p>
          <div className="section-head">
            <h2>Launches by this creator</h2>
          </div>
          {mine.length === 0 ? (
            <div className="empty">
              <p>This address has not launched anything here.</p>
            </div>
          ) : (
            <LaunchList rows={mine.map(toRow)} />
          )}
        </>
      )}
    </>
  );
}
