import { listTrades, currentHeight, symbolOf, type Quote, type Trade } from './chain.ts';
import { firstBlockShare } from './creatorHolding.ts';
import { buildSeries, changeBps, type Series } from './priceSeries.ts';
import { isDemoMode } from './demo.ts';
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
}

export type TradeViewResult =
  | { kind: 'demo' }
  | { kind: 'error'; message: string }
  | { kind: 'view'; view: TradeView };

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
}): Promise<TradeViewResult> {
  if (isDemoMode()) return { kind: 'demo' };

  let trades: Trade[];
  try {
    trades = await listTrades(curve, TRADE_LIMIT);
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
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
    },
  };
}
