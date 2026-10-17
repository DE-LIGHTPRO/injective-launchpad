import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DemoBanner } from '@/components/DemoBanner';
import { ArrowLeftIcon } from '@/components/Icons';
import { CopyButton } from '@/components/CopyButton';
import { LaunchList } from '@/components/LaunchList';
import { loadRows, toRow } from '@/lib/boardRows';
import { UnreadableNotice } from '@/components/UnreadableNotice';
import { compact } from '@/lib/boardMetrics';
import { totalsByQuote } from '@/lib/analytics';
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

  const { rows, error, errorDetail, unreadable } = await loadRows();
  const mine = rows.filter((r) => r.launch.creator === address);
  /*
   * Scoped to this creator, same predicate as `mine`. An unreadable launch of theirs
   * is the reason the fee totals below could be short, and nobody else's is.
   */
  const mineUnreadable = unreadable.filter((u) => u.creator === address);

  /*
   * Fees GROUPED PER QUOTE, not summed and not withheld.
   *
   * This read `boardTotals(mine)` and showed one figure each for fees paid and fees
   * unclaimed, falling back to a bare "." whenever a creator's launches did not all
   * share a quote. The reasoning was right - 18-decimal INJ added to 6-decimal
   * E2EUSD is wrong by twelve orders of magnitude, and there is no oracle here to
   * convert with - but refusing to say anything is not the remedy, and the page said
   * nothing about why. The only creator on testnet has four launches across two
   * quotes, so this screen's two money figures were both a dot, and the one note
   * under them talks about generated names.
   *
   * `totalsByQuote` is the shape this codebase already chose twice, on `/analytics`
   * ("Grouped, never summed") and in `Portfolio` ("Totals are per quote, never
   * summed across them"). Reusing it rather than re-deriving keeps a creator's own
   * page and the launchpad's analytics from disagreeing about what they were paid.
   */
  const byQuote = totalsByQuote(
    mine.map((r) => ({
      quoteDenom: r.quoteDenom,
      quote: { denom: r.quoteDenom, decimals: r.quoteDecimals, label: r.quoteLabel },
      graduated: r.graduated,
      raised: r.raised,
      feesAccrued: r.feesAccrued,
      creatorPaid: r.creatorPaid,
      platformPaid: r.platformPaid,
      openedAt: r.rules.openedAt,
      creator: r.launch.creator,
    })),
  );
  const launches = mine.length;
  const graduated = mine.filter((r) => r.graduated).length;

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

      {/*
          Above the stats and the fee section, both of which are sums over `mine`: a
          launch missing from that list makes every figure below a lower bound rather
          than a total, and the fee figures are the ones a creator acts on.
        */}
      {mineUnreadable.length > 0 && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <UnreadableNotice unreadable={mineUnreadable} />
        </div>
      )}
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
              <dd className="v">{launches}</dd>
            </div>
            <div className="stat">
              <dt className="k">Graduated</dt>
              <dd className="v">{graduated}</dd>
            </div>
            <div className="stat">
              <dt className="k">{byQuote.length === 1 ? 'Pair' : 'Pairs'}</dt>
              <dd className="v">{byQuote.length}</dd>
            </div>
          </dl>

          {byQuote.length > 0 && (
            <section className="card" style={{ marginTop: 'var(--space-4)' }}>
              <h2>What this creator has been paid</h2>
              <p className="note">
                One row per pair, never added together. These are amounts of different
                assets in their own decimals, and there is no price oracle here to
                convert them with.
              </p>
              {byQuote.map((q) => (
                <div key={q.quote.denom} style={{ marginTop: 'var(--space-4)' }}>
                  <div className="metric-row">
                    <span className="k">
                      <strong>{q.quote.label}</strong> · {q.launches}{' '}
                      {q.launches === 1 ? 'launch' : 'launches'}
                    </span>
                    <span className="v mono">{q.graduated} graduated</span>
                  </div>
                  <div className="metric-row">
                    {/*
                        PAID, which only ever rises, kept separate from accrued, which
                        drops to zero the moment it is claimed. One figure covering both
                        would fall when a creator was paid.
                      */}
                    <span className="k">Claimed by this creator, lifetime</span>
                    <span className="v mono">
                      {compact(q.paidToCreators, q.quote.decimals, 4)} {q.quote.label}
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="k">Accrued, not yet claimed</span>
                    <span className="v mono">
                      {compact(q.unclaimed, q.quote.decimals, 4)} {q.quote.label}
                    </span>
                  </div>
                </div>
              ))}
              <p className="note" style={{ marginTop: 'var(--space-4)' }}>
                Accrued is both sides of the fee, the creator&rsquo;s share and the
                launchpad&rsquo;s, because the contract holds them in one balance until
                a claim splits them.
              </p>
            </section>
          )}

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
            <LaunchList rows={mine.map((r) => toRow(r, rows))} />
          )}
        </>
      )}
    </>
  );
}
