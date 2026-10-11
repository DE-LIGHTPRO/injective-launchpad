/**
 * The board's rows, loaded once per request and shared by every page that lists
 * launches (home, watchlist, creator). One loader so the three can never disagree
 * about a launch's numbers.
 */
import { marketCap } from './boardMetrics.ts';
import { listLaunches, getLaunchDetail, listQuotes, quoteLabel, type Launch } from './chain.ts';
import { graduationProgress, type CurveConfig } from './curve.ts';
import { NETWORK } from './config.ts';
import type { LaunchRules } from './launchRules.ts';
import type { LaunchRow } from '../components/LaunchList.tsx';
import { launchPath } from './launchPath.ts';

export interface Row {
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
  quoteLabel: string;
}

/** Every row, with each one's path resolved against all of them. */
export function toRows(all: Row[]): LaunchRow[] {
  return all.map((r) => toRow(r, all));
}

export async function loadRows(): Promise<{ rows: Row[]; error?: string; errorDetail?: string }> {
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
          // After graduation the reserve lives in the locked pool.
          raised: d.pool ? d.pool.quote : d.state.injCollected,
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
          marketCap: marketCap(d.config, d.state, d.config.curveSupply + d.lpReserve, d.pool),
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
          quoteLabel: quoteLabel(d.quoteDenom, quotes),
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
/**
 * A board row's view model, including the URL the launch lives at.
 *
 * THE PATH IS COMPUTED HERE, from `all`, and that is the point of the second
 * argument. Whether `/launch/INJINU` is unambiguous is a property of the whole
 * board, not of the launch or of whichever subset a component happens to be
 * rendering, so a component holding a filtered list cannot work it out. Computing it
 * once, where the full list exists, is what stops the creator page and the watchlist
 * from emitting a shorter slug than the board does for the same token.
 */
export function toRow(r: Row, all: Row[]): LaunchRow {
  return {
    id: r.launch.id,
    denom: r.launch.denom,
    path: launchPath(r.launch, all.map((x) => x.launch)),
    curveAddress: r.launch.curve,
    quoteDenom: r.quoteDenom,
    quoteDecimals: r.quoteDecimals,
    quoteLabel: r.quoteLabel,
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

