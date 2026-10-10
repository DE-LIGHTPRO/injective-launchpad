import { CurveGlyph } from '@/components/CurveGlyph';
import { marketCap, boardTotals, compact } from '@/lib/boardMetrics';
import { KingOfTheHill } from '@/components/KingOfTheHill';
import { denomLabel } from '@/lib/chain';
import type { LaunchRules } from '@/lib/launchRules';
import Link from 'next/link';
import { listLaunches, getLaunchDetail, listQuotes, symbolOf, short, currentHeight, type Launch } from '@/lib/chain';
import { TradeTicker } from '@/components/TradeTicker';
import { HowItWorks } from '@/components/HowItWorks';
import { CurveExplorer } from '@/components/CurveExplorer';
import { ChainStatus } from '@/components/ChainStatus';
import { graduationProgress, fmt, type CurveConfig } from '@/lib/curve';
import { isDeployed, isDevBuild, NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { DemoBanner } from '@/components/DemoBanner';
import { LaunchList, type LaunchRow } from '@/components/LaunchList';

export const dynamic = 'force-dynamic';

interface Row {
  launch: Launch;
  raised: bigint;
  target: bigint;
  progress: number;
  graduated: boolean;
  rules: LaunchRules;
  config: CurveConfig;
  tokensSold: bigint;
  marketCap: bigint;
  feesAccrued: bigint;
  creatorPaid: bigint;
  quoteDenom: string;
  quoteDecimals: number;
}

async function loadRows(): Promise<{ rows: Row[]; error?: string; errorDetail?: string }> {
  try {
    const launches = await listLaunches();
    /*
     * The decimals of every allowlisted quote, read once from the factory.
     *
     * The same source the contract scaled each curve with. Deriving them per launch,
     * or keeping a table in the app, would be a second copy that could disagree with
     * the chain, and the disagreement would render as a reserve out by orders of
     * magnitude rather than as an error.
     */
    const { quotes } = await listQuotes();
    const quoteDecimals: Record<string, number> = {};
    for (const q of quotes) quoteDecimals[q.denom] = q.decimals;
    const rows = await Promise.all(
      launches.map(async (launch) => {
        const d = await getLaunchDetail(launch.curve);
        return {
          launch,
          raised: d.state.injCollected,
          target: d.config.graduationTarget,
          progress: graduationProgress(d.config, d.state),
          graduated: d.state.graduated,
          rules: d.rules,
          config: d.config,
          tokensSold: d.state.tokensSold,
          /*
           * Fully diluted: spot times the WHOLE supply, curve plus the reserve held
           * back for the pool. Every launchpad quotes it this way and it is still a
           * larger claim than it looks on a curve, which is why the card labels it
           * "MC" rather than calling it a valuation.
           */
          marketCap: marketCap(d.config, d.state, d.config.curveSupply + d.lpReserve),
          feesAccrued: d.creatorOwed + d.platformOwed,
          /*
           * PAID, not owed. `feesAccrued` above is what is sitting unclaimed right
           * now and falls back to zero the moment someone claims; this only ever
           * rises. They answer different questions and a board needs the second one:
           * "what has this launchpad handed to creators" is the number a creator
           * decides on, and nearly.trade puts it on their homepage for that reason.
           */
          creatorPaid: d.creatorPaid,
          quoteDenom: d.quoteDenom,
          /*
           * Decimals of THIS launch's quote. `getLaunchDetail` does not report them,
           * so they are resolved from the allowlist the factory publishes: the same
           * source the contract scaled the curve with, rather than a second copy.
           */
          quoteDecimals: quoteDecimals[d.quoteDenom] ?? NETWORK.quoteDecimals,
        };
      }),
    );
    return { rows };
  } catch (e) {
    const err = e as Error & { detail?: string };
    return { rows: [], error: err.message, errorDetail: err.detail };
  }
}

/**
 * Base units cross the server boundary as decimal strings.
 *
 * These are bigints on the server and bigints again in the list, but a bigint is
 * not serialisable as a server-component prop: passing one throws at render, and
 * passing it as a Number would silently lose precision at 18 decimals, which is
 * the quieter failure and the worse one.
 */
function toRow(r: Row): LaunchRow {
  return {
    id: r.launch.id,
    denom: r.launch.denom,
    curveAddress: r.launch.curve,
    quoteDenom: r.quoteDenom,
    quoteDecimals: r.quoteDecimals,
    creator: r.launch.creator,
    // Already normalised by `parseProfile` at the chain boundary. Plain strings and
    // nulls, so it crosses the server-component boundary without the bigint problem
    // described above.
    profile: r.launch.profile,
    // The list needs the rules only to label the status honestly; the row stays
    // serialisable because rules are a bigint-free shape by the time they get here.
    rules: r.rules,
    curve: {
      virtualInj: r.config.virtualInj.toString(),
      virtualTokens: r.config.virtualTokens.toString(),
      curveSupply: r.config.curveSupply.toString(),
      graduationTarget: r.config.graduationTarget.toString(),
      feeBps: r.config.feeBps.toString(),
    },
    tokensSold: r.tokensSold.toString(),
    marketCap: r.marketCap.toString(),
    openedAt: r.rules.openedAt,
    feesAccrued: r.feesAccrued.toString(),
    raised: r.raised.toString(),
    target: r.target.toString(),
    progress: r.progress,
    graduated: r.graduated,
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

      <h1>Launches</h1>
      <p className="sub">
        The creator supplies only tokens. Buyers bring {NETWORK.quoteSymbol}, and the curve
        prices every trade until it graduates.
      </p>

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

      {/*
          Always rendered, not only while the board is empty.
          
          These are the reasons to use this rather than another launchpad, and a
          differentiator that disappears the moment the product has content is one
          nobody reads. With nothing launched it is also the only thing on the page
          worth a visitor's time.
        */}
      {/*
          The explorer goes above the explainer: moving the handle once teaches a
          bonding curve faster than the three steps under it, and someone who
          understands it from the handle can skip the prose.
        */}
      <CurveExplorer />
      <HowItWorks />
      <ChainStatus height={height} />

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

          <div style={{ marginTop: 'var(--space-5)' }}>
            <LaunchList rows={rows.map(toRow)} />
          </div>
        </>
      )}
    </>
  );
}
