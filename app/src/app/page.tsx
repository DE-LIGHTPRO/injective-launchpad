import { boardTotals, compact } from '@/lib/boardMetrics';
import { KingOfTheHill } from '@/components/KingOfTheHill';
import { PairPanels } from '@/components/PairPanels';
import { denomLabel } from '@/lib/chain';
import Link from 'next/link';
import { currentHeight } from '@/lib/chain';
import { TradeTicker } from '@/components/TradeTicker';
import { HowItWorks } from '@/components/HowItWorks';
import { CurveExplorer } from '@/components/CurveExplorer';
import { ChainStatus } from '@/components/ChainStatus';
import { isDeployed, isDevBuild, NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { DemoBanner } from '@/components/DemoBanner';
import { LaunchList } from '@/components/LaunchList';
import { Hero, type HeroStats } from '@/components/Hero';
import { loadRows, toRow, type Row } from '@/lib/boardRows';

export const dynamic = 'force-dynamic';

/**
 * The hero's figures, for the busiest quote. Summing across quotes would add 18- and
 * 6-decimal base units together, so with several quotes the per-quote totals rows
 * further down carry the rest.
 */
function heroStats(rows: Row[]): HeroStats | null {
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.quoteDenom, (counts.get(r.quoteDenom) ?? 0) + 1);
  const quote = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const group = rows.filter((r) => r.quoteDenom === quote);
  const decimals = group[0].quoteDecimals;
  const t = boardTotals(
    group.map((r) => ({
      raised: r.raised,
      feesAccrued: r.feesAccrued,
      graduated: r.graduated,
      creatorPaid: r.creatorPaid,
    })),
  );
  const label = denomLabel(quote);
  return {
    launches: rows.length,
    liquidity: `${compact(t.raised, decimals)} ${label}`,
    graduated: t.graduated,
    paidToCreators: `${compact(t.paidToCreators, decimals)} ${label}`,
  };
}

export default async function Home() {
  const live = isDeployed() || isDemoMode();

  if (!live) {
    return (
      <>
        <h1>Launches</h1>
        <p className="sub">One-sided bonding curve launches on Injective.</p>
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p>No launches yet. Check back shortly.</p>
          {isDevBuild() && (
            <>
              <p className="note">
                Dev: nothing configured. Deploy to {NETWORK.name} and set the factory address, or
                run with NEXT_PUBLIC_DEMO=1 to explore the interface.
              </p>
              <code>NEXT_PUBLIC_FACTORY_ADDRESS=inj1…</code>
            </>
          )}
        </div>
      </>
    );
  }

  const { rows, error, errorDetail } = await loadRows();
  // Read alongside the rows rather than inside the ticker, so one slow call does not
  // serialise behind another.
  const height = await currentHeight();

  return (
    <>
      <DemoBanner />

      {/*
          Product first. This page used to open with a heading, a curve explainer, three
          steps and six guarantee cards, so the first launch sat ~3,000px down. Every
          launchpad people actually use leads with the market; the explaining now
          lives under the board for whoever scrolls to it.
        */}
      <Hero stats={heroStats(rows)} />

      {error && (
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p className="danger-text">{error}</p>
          {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
        </div>
      )}

      {/*
          The empty state of a live launchpad is, right now, the entire front page,
          and a bordered box reading "no launches yet" is a dead end: it reports a
          fact and offers nothing on the one screen where the action is obvious.

          It draws no curve. The explorer below is the same shape and can be moved
          along, so a static copy above it was the same picture twice with the worse
          one first. The message and the action stay; the explaining is done by the
          thing you can touch.
        */}
      {!error && rows.length === 0 && (
        <div className="empty-hero empty-hero-compact" style={{ marginTop: 'var(--space-5)' }}>
          <h2>Nothing has launched yet</h2>
          <p className="note">
            Every token here starts on a curve. The creator supplies the tokens,
            buyers bring {NETWORK.quoteSymbol}, and the price rises along it until the
            launch graduates to a pool. Move the handle below to see how.
          </p>
          <Link href="/create" className="go empty-cta">
            Create the first launch
          </Link>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/*
              The ticker sits above the totals: what is happening now reads before
              what has happened in aggregate, and it renders nothing at all when
              there are no trades rather than reserving space for the absence.
            */}
          <TradeTicker
            launches={rows.map((r) => ({
              id: r.launch.id,
              curve: r.launch.curve,
              denom: r.launch.denom,
              quoteDecimals: r.quoteDecimals,
              quoteLabel: denomLabel(r.quoteDenom),
            }))}
            currentHeight={height}
          />

          {/*
              Totals summed from the rows already on screen, not from a second query.
              A totals bar with its own data source is the classic place for a page to
              contradict itself, and a visitor who adds up the cards and gets a
              different number trusts neither figure afterwards.
            */}
          {(() => {
            /*
             * GROUPED BY QUOTE, because a total is a sum of base units and base units
             * of different quotes are different things. One INJ launch and one USDC
             * launch summed together add 18-decimal units to 6-decimal units and the
             * answer is wrong by twelve orders of magnitude. There is no price oracle
             * here to convert with, so the honest form is one row per quote rather
             * than one number that spans them.
             *
             * With a single quote this renders exactly as it did before.
             */
            const byQuote = new Map<string, { decimals: number; rows: typeof rows }>();
            for (const r of rows) {
              const g = byQuote.get(r.quoteDenom) ?? { decimals: r.quoteDecimals, rows: [] };
              g.rows.push(r);
              byQuote.set(r.quoteDenom, g);
            }
            // One quote: the hero already shows these figures. Several: one row each.
            if (byQuote.size < 2) return null;
            return [...byQuote.entries()].map(([quote, g]) => {
              const t = boardTotals(
                g.rows.map((r) => ({
                  raised: r.raised,
                  feesAccrued: r.feesAccrued,
                  graduated: r.graduated,
                  creatorPaid: r.creatorPaid,
                })),
              );
              return (
                <div className="totals" key={quote}>
                  <div>
                    <span className="v mono">{t.launches}</span>
                    <span className="k">
                      {byQuote.size > 1 ? `Launches in ${denomLabel(quote)}` : 'Launches'}
                    </span>
                  </div>
                  <div>
                    {/*
                        "In curve reserves", not "volume". A sell reduces the reserve,
                        so this falls when people exit where volume never would.
                      */}
                    <span className="v mono">
                      {compact(t.raised, g.decimals)} {denomLabel(quote)}
                    </span>
                    <span className="k">In curve reserves</span>
                  </div>
                  <div>
                    <span className="v mono">
                      {compact(t.feesAccrued, g.decimals, 4)} {denomLabel(quote)}
                    </span>
                    <span className="k">Fees unclaimed</span>
                  </div>
                  <div>
                    <span className="v mono">
                      {compact(t.paidToCreators, g.decimals, 4)} {denomLabel(quote)}
                    </span>
                    <span className="k">Paid to creators</span>
                  </div>
                  <div>
                    <span className="v mono">{t.graduated}</span>
                    <span className="k">Graduated</span>
                  </div>
                </div>
              );
            });
          })()}

          {(() => {
            /*
             * ONE QUOTE, the one with the most launches. Ranking by market cap across
             * quotes compares base units of different assets, which without a price
             * oracle is not a ranking at all. Picking the largest group keeps the
             * strip about the busiest market rather than whichever quote sorted first.
             */
            const counts = new Map<string, number>();
            for (const r of rows) counts.set(r.quoteDenom, (counts.get(r.quoteDenom) ?? 0) + 1);
            const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            const forHill = rows.filter((r) => r.quoteDenom === biggest).map(toRow);
            return (
              <KingOfTheHill rows={forHill} nowSeconds={Math.floor(Date.now() / 1000)} />
            );
          })()}

          <PairPanels rows={rows.map(toRow)} />

          <div className="section-head" id="board">
            <h2>All launches</h2>
          </div>
          <LaunchList rows={rows.map(toRow)} />
        </>
      )}

      {/*
          Still always rendered: these are the reasons to use this launchpad rather
          than another, and a differentiator that disappears once there is content is
          one nobody reads. Below the market now, not in front of it.
        */}
      <div className="section-head">
        <h2>How it works</h2>
      </div>
      <CurveExplorer />
      <HowItWorks />
      <ChainStatus height={height} />
    </>
  );
}
