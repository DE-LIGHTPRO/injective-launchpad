import {
  listTrades,
  listTradeHistoryEvm,
  currentHeight,
  symbolOf,
  type LaunchDetail,
  type Quote,
  type Trade,
} from './chain.ts';
import { firstBlockShare } from './creatorHolding.ts';
import { buildSeries, changeBps, type Series } from './priceSeries.ts';
import { isDemoMode } from './demo.ts';
import { isEvm } from './config.ts';
import {
  uniqueTraders,
  volumeWithin,
  volumeIsPartial,
  BLOCKS_PER_DAY,
} from './launchActivity.ts';

/**
 * Everything the launch page derives from one launch's trade history.
 *
 * ONE FETCH, TWO SURFACES. The price chart at the top of the page and the trade list
 * further down are the same data asked two ways. `Trades` used to fetch it itself,
 * which was fine while it was the only consumer; promoting candles to the page's main
 * chart would otherwise have meant a second `listTrades` for the same curve on the
 * same render. Two reads of one fact is the defect this codebase keeps finding, and
 * here it would also double a tx-search request on the page people actually open.
 *
 * It returns a RESULT rather than throwing, because the three outcomes send a reader
 * somewhere different and the page renders each of them differently:
 *
 *   demo     there is no chain to read, which is said rather than shown as emptiness
 *   error    the node was unreachable, which is not evidence about whether it traded
 *   view     the data, which may legitimately contain no trades at all
 */

export interface TradeView {
  trades: Trade[];
  series: Series;
  /** Token ticker, derived once. */
  sym: string;
  /** Current block, or null. `null` makes every windowed figure unknown, never zero. */
  height: number | null;
  /** Quote traded in about 24h, or null when the window is unknown. */
  vol24: bigint | null;
  /** True when the 24h sum is a floor rather than a total. */
  volPartial: boolean;
  traders: number;
  /** Change across the series in bps, or null when there is nothing to compare. */
  change: number | null;
  /** Share of supply taken in the opening blocks, as a percentage, or null. */
  openingPct: number | null;
  /** Blocks the opening-share window covers, for the copy that reports it. */
  openingBlocks: number | null;
  /**
   * Which blocks the history was actually read over, on a backend that reads a window.
   *
   * `null` ON THE COSMWASM BACKEND, where history comes from a transaction search that
   * either answers or does not, and its partiality is already reported by the error
   * branch and by `volPartial`. On the EVM backend `eth_getLogs` is capped at 10,000
   * blocks a request, so a full history cannot be scanned and the list is a window -
   * which the UI has to SAY, because a prefix and a complete history are the same
   * array. See `evm/trades.ts`.
   */
  coverage: {
    complete: boolean | null;
    scannedFrom: number;
    head: number;
    openingWindow: { from: number; to: number } | null;
  } | null;
}

export type TradeViewResult =
  | { kind: 'demo' }
  | { kind: 'error'; message: string; tradedOnChain: boolean }
  | { kind: 'view'; view: TradeView; tradedOnChain: boolean };

/**
 * Whether the CURVE says this launch has ever traded, which the tx search cannot.
 *
 * THE TRADE SURFACES WERE ASKING ONE SOURCE AND GIVING ONE ANSWER. Trade history
 * comes from the chain's own transaction search, and the node that answers keeps a
 * window of recent blocks: a launch older than that window gets a 500, which the page
 * renders as "this says nothing about whether the launch has traded", and an empty
 * result renders as "nothing yet". Both are read off the search alone while the page
 * already holds the contract's state from a query that succeeded.
 *
 * Measured against the live testnet on 17 Oct 2026: all four launches on the factory
 * returned `height N is not available, lowest height is M`, including one with
 * 495,558 tokens sold and one graduated with the whole 800,000,000 curve supply sold.
 * So the chart disabled its Market tab with the tooltip "No trades yet" and the trade
 * card declined to say either way, about two launches whose own state settles it.
 *
 * MONOTONIC EVIDENCE ONLY, which is the whole difficulty. `tokensSold` and
 * `injCollected` both go back DOWN on a sell, so a buyer who sold out completely
 * returns them to zero; `graduated` and the lifetime fee counters never reverse, and
 * a fee accrues on the first buy. `owed + paid` is therefore the durable half, and it
 * is why this takes the detail rather than just the curve state.
 *
 * It returns false rather than null for the all-zero case. The one way that is wrong
 * is a curve deployed before the `*_paid` counters existed whose fees were then fully
 * paid out, which `getLaunchDetail` reads as zero and cannot distinguish from absent.
 * The mainnet factory deploys counted curves, so on mainnet all-zero means untraded.
 */
export function hasEverTraded(
  d: Pick<
    LaunchDetail,
    'state' | 'platformOwed' | 'creatorOwed' | 'platformPaid' | 'creatorPaid'
  >,
): boolean {
  if (d.state.graduated) return true;
  if (d.state.tokensSold > 0n || d.state.injCollected > 0n) return true;
  return d.platformOwed + d.creatorOwed + d.platformPaid + d.creatorPaid > 0n;
}

/**
 * How many trades one page load reads. Bounds the chart, the 24h sum and the list.
 *
 * RAISED FROM 25 FOR THE CHART. The trade list only ever shows the newest handful,
 * but a candle chart with 25 fills has a dozen candles on any useful interval, and
 * the 24h volume is a floor rather than a total the moment the window holds more
 * than this. One page of a tx search costs one request whatever the limit, so the
 * cost is the response size rather than another round trip.
 */
export const TRADE_LIMIT = 200;

/** How many of them the trade list renders. The chart uses all of them. */
export const TRADE_LIST_LIMIT = 25;

export async function loadTradeView({
  curve,
  denom,
  quote,
  totalSupply,
  tradedOnChain,
}: {
  curve: string;
  denom: string;
  /**
   * THIS launch's quote. `buildSeries` takes the decimals because a fill price is
   * quote over tokens, so a 6-decimal quote read as 18 puts every point on the chart
   * out by a factor of a trillion.
   */
  quote: Quote;
  /** Base units as a string, for the opening-concentration figure. */
  totalSupply?: string;
  /**
   * `hasEverTraded(detail)`, from the contract state the caller already read. Carried
   * on the result so the chart and the trade list reach the same verdict from one
   * resolver instead of each deriving it from whatever it happens to hold.
   */
  tradedOnChain: boolean;
}): Promise<TradeViewResult> {
  if (isDemoMode()) return { kind: 'demo' };

  let trades: Trade[];
  let coverage: TradeView['coverage'] = null;
  try {
    if (isEvm()) {
      /*
       * THE WINDOW COMES BACK WITH THE TRADES, because the UI has to report it. Read
       * through `listTradeHistoryEvm` rather than `listTrades` for exactly that: the
       * plain call returns the array and drops which blocks produced it, and a page
       * that renders a window as a history is the partial-read-as-absence defect.
       */
      const h = await listTradeHistoryEvm(curve, TRADE_LIMIT);
      trades = h.trades;
      coverage = {
        complete: h.complete,
        scannedFrom: h.scannedFrom,
        head: h.head,
        openingWindow: h.openingWindow,
      };
    } else {
      trades = await listTrades(curve, TRADE_LIMIT);
    }
  } catch (e) {
    return { kind: 'error', message: (e as Error).message, tradedOnChain };
  }

  const series = buildSeries(trades, quote.decimals);
  /*
   * Read here rather than passed in. `null` on failure, which `volumeWithin` turns
   * into "not measured" rather than zero: a day with no trades and a day we could not
   * measure must not read the same.
   */
  const height = await currentHeight().catch(() => null);
  const opening = totalSupply ? firstBlockShare(trades, BigInt(totalSupply)) : null;

  return {
    kind: 'view',
    tradedOnChain,
    view: {
      trades,
      series,
      sym: symbolOf(denom),
      height,
      vol24: volumeWithin(trades, height, BLOCKS_PER_DAY),
      volPartial: volumeIsPartial(trades, trades.length, height, BLOCKS_PER_DAY),
      traders: uniqueTraders(trades),
      change: changeBps(series),
      openingPct: opening?.share != null ? opening.share * 100 : null,
      openingBlocks: opening?.blocks ?? null,
      coverage,
    },
  };
}
