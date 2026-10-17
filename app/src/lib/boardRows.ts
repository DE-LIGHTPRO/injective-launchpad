/**
 * The board's rows, loaded once per request and shared by every page that lists
 * launches (home, watchlist, creator). One loader so the three can never disagree
 * about a launch's numbers.
 */
import { marketCap } from './boardMetrics.ts';
import {
  listLaunches,
  getLaunchDetail,
  listQuotes,
  quoteLabel,
  mapWithConcurrency,
  DETAIL_CONCURRENCY,
  type Launch,
  type LaunchDetail,
} from './chain.ts';
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
  /**
   * Lifetime, actually paid to the launchpad.
   *
   * Carried even though no board column shows it, because the creator page groups
   * these rows through `totalsByQuote`, which takes both sides. Passing a `0n` in
   * its place would have put an unmeasured zero into a shared aggregator for the
   * sake of a figure that screen does not render.
   */
  platformPaid: bigint;
  quoteDenom: string;
  quoteDecimals: number;
  quoteLabel: string;
}

/**
 * A launch the factory listed whose curve would not answer.
 *
 * It is NOT an absence. The factory named it, so something is there; a board that
 * quietly dropped it would be the silently-truncated list `listLaunches` was rewritten
 * to fix, arriving by a different route. The denom is carried so a notice can name what
 * is missing rather than count it.
 */
export interface UnreadableLaunch {
  id: number;
  denom: string;
  /**
   * From the factory's list, not from the curve - which is the only reason this field
   * can exist on a launch whose curve would not answer. The creator page filters rows
   * by creator and has to filter this the same way, or it would warn somebody about a
   * gap in a stranger's launch while saying nothing about the gap in their own fee
   * total.
   */
  creator: string;
  reason: string;
  detail?: string;
}

export interface BoardLoad {
  rows: Row[];
  /** Set only when NOTHING could be read. A partial read is `unreadable`, not an error. */
  error?: string;
  errorDetail?: string;
  /** Empty on a clean read. Every page that renders `rows` must render this too. */
  unreadable: UnreadableLaunch[];
}

/** Every row, with each one's path resolved against all of them. */
export function toRows(all: Row[]): LaunchRow[] {
  return all.map((r) => toRow(r, all));
}

export async function loadRows(): Promise<BoardLoad> {
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
    /*
     * BOUNDED, AND ONE BAD CURVE DOES NOT EMPTY THE BOARD. This was a bare
     * `Promise.all` over every launch, which failed twice over.
     *
     * It fired 2N requests at once - see `DETAIL_CONCURRENCY` for what the endpoint
     * does to a burst - and `Promise.all` rejects on the FIRST failure, so a single
     * unreadable curve fell into the catch below and returned `{ rows: [] }` with that
     * one curve's message as the whole board's error. Four pages render this loader.
     * The hostname is a load balancer and we have measured it answering one node's
     * refusal where another serves, so "one read failed" is a thing that happens on a
     * healthy chain, and it should cost that launch's row, not the launchpad's front
     * page.
     *
     * The per-launch catch is what makes this a settled read; `mapWithConcurrency`
     * deliberately does not do it for us.
     */
    type Settled =
      | { launch: Launch; detail: LaunchDetail }
      | { launch: Launch; failure: { reason: string; detail?: string } };

    const settled = await mapWithConcurrency<Launch, Settled>(
      launches,
      DETAIL_CONCURRENCY,
      async (launch) => {
        try {
          return { launch, detail: await getLaunchDetail(launch.curve) };
        } catch (e) {
          const err = e as Error & { detail?: string };
          /*
           * The notice interpolates `reason`, so a blank one renders a sentence with a
           * hole in it. In practice `smartQuery` already prevents that: it catches a
           * fetch throw and raises a `ChainError` carrying its own words, keeping the
           * thrown value as `detail`. So this fallback does not fire today, and
           * `board-partial-read.test.ts` says so rather than pretending to exercise it -
           * three drafts of a test for it passed under `??` as well, which is what
           * showed the guarantee lives one layer down.
           *
           * It stays because it is one `||` against a future throw site that does not go
           * through `smartQuery`, and `||` rather than `??` because an empty message is
           * not an absent one.
           */
          return {
            launch,
            failure: { reason: err?.message || 'The curve did not answer.', detail: err?.detail },
          };
        }
      },
    );

    const unreadable: UnreadableLaunch[] = [];
    const rows: Row[] = [];
    for (const r of settled) {
      if ('failure' in r) {
        unreadable.push({
          id: r.launch.id,
          denom: r.launch.denom,
          creator: r.launch.creator,
          ...r.failure,
        });
        continue;
      }
      const { launch, detail: d } = r;
      rows.push({
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
        platformPaid: d.platformPaid,
        quoteDenom: d.quoteDenom,
        /*
         * Decimals of THIS launch's quote. `getLaunchDetail` does not report them,
         * so they are resolved from the allowlist the factory publishes: the same
         * source the contract scaled the curve with, rather than a second copy.
         */
        quoteDecimals: quoteDecimals[d.quoteDenom] ?? NETWORK.quoteDecimals,
        quoteLabel: quoteLabel(d.quoteDenom, quotes),
      });
    }

    /*
     * EVERY launch failing is an outage, not a partial read. Reporting it as a notice
     * over an empty board would say "4 launches could not be read" where the honest
     * reading is that the endpoint is not answering - and it would lose the error copy
     * `translateQueryError` picked, which is the half that distinguishes a pruned
     * height from a mistyped factory address.
     */
    if (rows.length === 0 && unreadable.length > 0) {
      return { rows: [], unreadable, error: unreadable[0].reason, errorDetail: unreadable[0].detail };
    }
    return { rows, unreadable };
  } catch (e) {
    const err = e as Error & { detail?: string };
    return { rows: [], unreadable: [], error: err.message, errorDetail: err.detail };
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

