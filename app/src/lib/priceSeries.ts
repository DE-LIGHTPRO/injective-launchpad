import type { Trade } from './chain.ts';

/**
 * A price series built from trades that actually happened.
 *
 * Every launchpad shows a price chart, and there are two ways to draw one. The
 * curve chart already on the launch page is the *shape*: what the contract will
 * charge at any point, computed from the config. This is the *history*: what
 * people actually paid, computed from the chain's own transaction log.
 *
 * They answer different questions and neither substitutes for the other. The
 * curve says what a trade will cost; the history says what the market has done.
 *
 * THESE ARE FILL PRICES, NOT SPOT. A buy's price here is what the buyer paid
 * divided by what they received, so it includes both the fee and the price impact
 * of their own trade. That is the honest number for "what did this cost", and it
 * is deliberately not the same as the spot price the panel quotes: on a steep
 * curve a large buy fills well above spot, and a chart drawn from spot would hide
 * exactly that. Labelled as fills wherever it is shown.
 */

export interface PricePoint {
  /** Block height, which is the only ordering the chain gives us. */
  height: number;
  /** Quote per whole token, as a float for drawing only. */
  price: number;
  side: 'buy' | 'sell';
  txHash: string;
}

export interface Series {
  points: PricePoint[];
  /** First and last by height, for an axis. Null when there is nothing to draw. */
  first: PricePoint | null;
  last: PricePoint | null;
  low: number;
  high: number;
  /** Trades that carried amounts we could not price, reported rather than dropped. */
  unpriceable: number;
}

/**
 * A series with nothing in it.
 *
 * Exported so a caller that could not read trades renders the same empty state as a
 * launch that has not traded, rather than each one inventing its own placeholder.
 * The two are different facts, and the page says which; the CHART is blank either
 * way, and that is one shape, not two.
 */
export const EMPTY_SERIES: Series = {
  points: [],
  first: null,
  last: null,
  low: 0,
  high: 0,
  unpriceable: 0,
};

/**
 * Price of one whole token from one trade.
 *
 * Both sides use the amount that actually moved, so a buy is priced on the quote
 * the buyer spent including fee and a sell on the quote the seller received after
 * it. That asymmetry is real: it is the spread a round trip pays, and smoothing it
 * away would draw a line nobody traded on.
 *
 * Scaled through integers before the single division, because quote and token are
 * both 18 decimals here and `Number(1e18) / Number(1e24)` loses the answer before
 * it is computed.
 */
export function fillPrice(t: Trade, quoteDecimals = 18, tokenDecimals = 18): number | null {
  const quote = t.kind === 'buy' ? t.injIn : t.kind === 'sell' ? t.injOut : null;
  if (quote === null || t.tokens === null) return null;
  if (quote <= 0n || t.tokens <= 0n) return null;

  /*
   * FLOAT DIVISION, DELIBERATELY, and the first version here was integer-scaled
   * on reasoning that measurement contradicted.
   *
   * It computed `quote * 10^td * 1e12 / (tokens * 10^qd)` in bigint and divided
   * by the scale, with a comment claiming the scale was needed to survive a
   * launch token's eight leading zeros. Measured across the range:
   *
   *   1 INJ / 189,829 tok   scaled 5.267899e-6   float 5.267899e-6   diff 7e-10
   *   huge / huge           scaled 3.333333e-1   float 3.333333e-1   diff 1e-12
   *   1 wei / 1e24          scaled 0             float 1.000000e-24
   *   1e12   / 1e27         scaled 0             float 1.000000e-15
   *
   * So the scaling bought nothing realistic and FLOORED TO ZERO below 1e-12,
   * where `buildSeries` then counted the fill as unpriceable and dropped it. A
   * token priced under 1e-12 quote would have had every trade silently vanish
   * from its chart, which on a launchpad is an entirely ordinary token.
   *
   * This value is drawn, never settled against, so float is the right precision
   * for it. The ratio survives `Number()` on operands past 2^53 to about 1e-12
   * relative, measured above, which is far finer than a line on a chart.
   */
  const qd = 10 ** quoteDecimals;
  const td = 10 ** tokenDecimals;
  const price = Number(quote) / qd / (Number(t.tokens) / td);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Build the series, oldest first.
 *
 * The tx search returns newest first because that is what a feed wants, and a
 * chart drawn in that order runs backwards. Sorted here rather than relied upon,
 * since the ordering is the API's choice and not a guarantee.
 */
export function buildSeries(trades: readonly Trade[], quoteDecimals = 18): Series {
  const points: PricePoint[] = [];
  let unpriceable = 0;

  for (const t of trades) {
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    const price = fillPrice(t, quoteDecimals);
    if (price === null || !Number.isFinite(price) || price <= 0) {
      // Counted, not discarded. A chart missing half its trades without saying so
      // is a chart that lies about the period it covers.
      unpriceable += 1;
      continue;
    }
    points.push({ height: t.height, price, side: t.kind, txHash: t.txHash });
  }

  points.sort((a, b) => a.height - b.height);

  if (points.length === 0) {
    return { points, first: null, last: null, low: 0, high: 0, unpriceable };
  }

  const prices = points.map((p) => p.price);
  return {
    points,
    first: points[0],
    last: points[points.length - 1],
    low: Math.min(...prices),
    high: Math.max(...prices),
    unpriceable,
  };
}

/**
 * Change from the first fill to the last, in basis points.
 *
 * Null when there is only one point, because a single trade has nothing to be a
 * change from. Reporting 0% there would claim the price has held steady over a
 * period that does not exist.
 */
export function changeBps(s: Series): number | null {
  if (!s.first || !s.last || s.points.length < 2) return null;
  if (s.first.price <= 0) return null;
  return Math.round(((s.last.price - s.first.price) / s.first.price) * 10_000);
}

/*
 * `pathFor` lived here and drew the fill series as a line. It went when the launch
 * page moved to candles: a line joins fills and hides what happened between them, so
 * a bucket that opened low, spiked and closed low read as flat.
 *
 * Deleted rather than kept "in case": an exported function with no caller is the
 * thing this codebase keeps finding, and `git` remembers it better than a comment
 * would.
 */
