import type { Metadata } from 'next';
import Link from 'next/link';
import {
  listLaunches,
  getLaunchDetail,
  listQuotes,
  short,
  type Quote,
} from '@/lib/chain';
import { NETWORK } from '@/lib/config';
import { compact } from '@/lib/boardMetrics';
import { denomLabel } from '@/lib/chain';
import {
  totalsByQuote,
  launchesPerDay,
  topCreators,
  graduationRate,
  type AnalyticsRow,
} from '@/lib/analytics';
import { addressName } from '@/lib/addressName';

export const metadata: Metadata = {
  title: 'Analytics · Vetta',
  description: 'What this launchpad has actually done, measured from chain state.',
};

export const revalidate = 30;

/**
 * Analytics, built only from what the chain will answer for.
 *
 * Both comparable launchpads run one of these and both can show figures this cannot,
 * because they have indexers. Rather than approximate those, this page states what
 * is missing and why, at the bottom, so a reader can tell the difference between a
 * launchpad that is quiet and a page that is guessing.
 */
export default async function AnalyticsPage() {
  let rows: AnalyticsRow[] = [];
  let failed: string | null = null;

  try {
    const [launches, { quotes }] = await Promise.all([listLaunches(), listQuotes()]);
    const decimals: Record<string, number> = {};
    for (const q of quotes) decimals[q.denom] = q.decimals;

    rows = await Promise.all(
      launches.map(async (l) => {
        const d = await getLaunchDetail(l.curve);
        const quote: Quote = {
          denom: d.quoteDenom,
          decimals: decimals[d.quoteDenom] ?? NETWORK.quoteDecimals,
          label: denomLabel(d.quoteDenom),
        };
        return {
          quoteDenom: d.quoteDenom,
          quote,
          graduated: d.state.graduated,
          raised: d.state.injCollected,
          feesAccrued: d.creatorOwed + d.platformOwed,
          creatorPaid: d.creatorPaid,
          platformPaid: d.platformPaid,
          openedAt: d.rules.openedAt ?? null,
          creator: d.creator,
        } satisfies AnalyticsRow;
      }),
    );
  } catch (e) {
    failed = (e as Error).message;
  }

  const totals = totalsByQuote(rows);
  const rate = graduationRate(rows);
  const now = Math.floor(Date.now() / 1000);
  const perDay = launchesPerDay(rows, now, 14);
  const creators = topCreators(rows);
  const peak = Math.max(1, ...perDay.map((d) => d.count));

  return (
    <>
      <h1>Analytics</h1>
      <p className="note">
        Measured from chain state at page load, not from an index. Every figure below
        is something the chain will answer for directly.
      </p>

      {failed && <p className="note danger-text">Could not read the chain: {failed}</p>}

      {!failed && rows.length === 0 && (
        <div className="empty" style={{ marginTop: 'var(--space-4)' }}>
          <p>Nothing has launched yet, so there is nothing to measure.</p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="totals" style={{ marginTop: 'var(--space-4)' }}>
            <div>
              <span className="v mono">{rows.length}</span>
              <span className="k">Launches</span>
            </div>
            <div>
              <span className="v mono">{rows.filter((r) => r.graduated).length}</span>
              <span className="k">Graduated</span>
            </div>
            <div>
              {/*
                  `null` for an empty board rather than 0%: "none of zero launches
                  graduated" is not a 0% rate, and a headline reading 0% on a new
                  launchpad says something false about it.
                */}
              <span className="v mono">{rate === null ? 'n/a' : `${(rate * 100).toFixed(0)}%`}</span>
              <span className="k">Graduation rate</span>
            </div>
            <div>
              <span className="v mono">{totals.length}</span>
              <span className="k">{totals.length === 1 ? 'Pair' : 'Pairs'}</span>
            </div>
          </div>

          <section className="card" style={{ marginTop: 'var(--space-5)' }}>
            <h2>By pair</h2>
            <p className="note">
              Grouped, never summed. These are base units in each asset&rsquo;s own
              decimals, and there is no price oracle here to convert them with.
            </p>
            {totals.map((t) => (
              <div key={t.quote.denom} style={{ marginTop: 'var(--space-4)' }}>
                <div className="metric-row">
                  <span className="k">
                    <strong>{t.quote.label}</strong> · {t.launches}{' '}
                    {t.launches === 1 ? 'launch' : 'launches'}
                  </span>
                  <span className="v mono">{t.graduated} graduated</span>
                </div>
                <div className="metric-row">
                  {/*
                      "In curve reserves", not volume. A sell reduces this where
                      volume never would, so they are different claims and only this
                      one is answerable from state.
                    */}
                  <span className="k">In curve reserves</span>
                  <span className="v mono">
                    {compact(t.reserves, t.quote.decimals, 4)} {t.quote.label}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Paid to creators, lifetime</span>
                  <span className="v mono">
                    {compact(t.paidToCreators, t.quote.decimals, 4)} {t.quote.label}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Paid to the launchpad, lifetime</span>
                  <span className="v mono">
                    {compact(t.paidToPlatform, t.quote.decimals, 4)} {t.quote.label}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Accrued, not yet claimed</span>
                  <span className="v mono">
                    {compact(t.unclaimed, t.quote.decimals, 4)} {t.quote.label}
                  </span>
                </div>
              </div>
            ))}
          </section>

          <section className="card" style={{ marginTop: 'var(--space-4)' }}>
            <h2>Launches per day</h2>
            <p className="note">
              From each launch&rsquo;s recorded opening time. A launch whose opening
              time the contract does not carry is left out rather than counted as
              today&rsquo;s.
            </p>
            <div className="daybars" role="img" aria-label="Launches per day, last 14 days">
              {[...perDay].reverse().map((d) => (
                <div className="daybar" key={d.day} title={`${d.count} on day -${d.day}`}>
                  <i style={{ height: `${(d.count / peak) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="spark-foot mono">
              <span>14 days ago</span>
              <span>today</span>
            </div>
          </section>

          {creators.length > 0 && (
            <section className="card" style={{ marginTop: 'var(--space-4)' }}>
              <h2>Most active creators</h2>
              <p className="note">
                By launches created. Not by fees earned: fees are denominated in each
                launch&rsquo;s quote, so adding a creator&rsquo;s across pairs would
                produce a number that is not an amount of anything.
              </p>
              {creators.map((c) => (
                <div className="metric-row" key={c.creator}>
                  <span className="k">
                    <Link href={`/creator/${c.creator}`}>{addressName(c.creator)}</Link>{' '}
                    <span className="hint mono">{short(c.creator)}</span>
                  </span>
                  <span className="v mono">
                    {c.launches} {c.launches === 1 ? 'launch' : 'launches'}
                    {c.graduated > 0 && `, ${c.graduated} graduated`}
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <section className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h2>What is not here, and why</h2>
        <p className="note">
          Stated rather than omitted, so a quiet launchpad and a page that is guessing
          are distinguishable.
        </p>
        <div className="metric-row">
          <span className="k">Lifetime volume</span>
          <span className="v">
            Needs every trade ever. Injective&rsquo;s transaction search pages, so a
            board-wide scan is unbounded work that grows with the product. Curve
            reserves are shown instead, which is a different claim: a sell reduces
            them where volume never would.
          </span>
        </div>
        <div className="metric-row">
          <span className="k">Holder counts</span>
          <span className="v">
            <code>denom_owners</code> answers &ldquo;not implemented&rdquo; for a
            tokenfactory denom on Injective. Deriving it from trade history would be
            wrong rather than approximate, because a bank send runs no contract code,
            so every transfer off the curve is invisible.
          </span>
        </div>
        <div className="metric-row">
          <span className="k">Anything in dollars</span>
          <span className="v">
            There is no price oracle wired in, so every figure is in its own quote
            asset and nothing is converted or summed across pairs.
          </span>
        </div>
      </section>
    </>
  );
}
