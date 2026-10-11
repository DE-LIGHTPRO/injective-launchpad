import type { PricePoint, Series } from './priceSeries.ts';

/**
 * Fill prices bucketed into candles.
 *
 * WHY BY BLOCK HEIGHT AND NOT BY TIME. Height is the only ordering this chain gives
 * a trade: `listTrades` reads the transaction log, and a log entry carries a height,
 * not a wall-clock timestamp we can trust. Bucketing by a derived time would put a
 * precise-looking label on an estimate, which is the thing this codebase removes
 * everywhere else. The axis says "blocks", and a caller that wants an approximate
 * duration converts it and says "about".
 *
 * EMPTY BUCKETS ARE DROPPED, not carried forward. A gap means nobody traded, and a
 * candle drawn across it would invent an open, high, low and close for a period with
 * no trades in it. Most charting libraries carry the last close forward; on a
 * launchpad where a token can sit untouched for hours, that draws a flat line nobody
 * traded on and makes an illiquid token look stable.
 */

export interface Candle {
  /** First block in the bucket. Buckets are `span` blocks wide. */
  from: number;
  to: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Trades in the bucket. Zero never appears: an empty bucket is omitted. */
  trades: number;
}

/**
 * Group a series into at most `want` candles.
 *
 * The span is derived from the data's own range rather than fixed, so a launch an
 * hour old and one a week old both produce a readable chart. A fixed span would give
 * the new launch one candle and the old one thousands.
 */
export function toCandles(series: Series, want = 24): Candle[] {
  const pts = series.points;
  if (pts.length === 0) return [];

  const first = pts[0].height;
  const last = pts[pts.length - 1].height;

  /*
   * THE BUCKET COUNT IS BOUNDED BY HOW MANY TRADES THERE ARE, not just by the block
   * range, and that is what makes the chart readable on a young launch.
   *
   * Measured on a real launch: 5 trades across 9 blocks, asked for 40 candles. The
   * span came out at 1 block, so every bucket held exactly ONE trade, every candle
   * had open == close == high == low, and the chart drew five 1-pixel dashes. Every
   * number in it was correct. A candle needs more than one fill in it to have a body
   * or a wick, so a bucket per trade is a chart that cannot show anything.
   *
   * Two trades per candle is the floor; beyond that `want` takes over, so a busy
   * launch still gets the full resolution. Buckets stay BLOCK ranges, which is what
   * keeps two trades in one block in one candle; only how many of them is chosen
   * from the data's density.
   */
  const bucketCount = Math.min(want, Math.max(1, Math.ceil(pts.length / 2)));
  // At least 1, so a burst of trades inside a single block still buckets.
  const span = Math.max(1, Math.ceil((last - first + 1) / bucketCount));

  const buckets = new Map<number, PricePoint[]>();
  for (const p of pts) {
    const slot = Math.floor((p.height - first) / span);
    const list = buckets.get(slot) ?? [];
    list.push(p);
    buckets.set(slot, list);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, group]) => {
      // `points` is already sorted by height, so group order is chronological and
      // open/close are the first and last FILLS rather than the min and max.
      const prices = group.map((g) => g.price);
      return {
        from: first + slot * span,
        to: first + (slot + 1) * span - 1,
        open: prices[0],
        close: prices[prices.length - 1],
        high: Math.max(...prices),
        low: Math.min(...prices),
        trades: group.length,
      };
    });
}

/**
 * The price-to-pixel mapping a chart and its axis must agree on.
 *
 * EXPORTED, and that is the point. The axis labels and the candles are two drawings
 * of one scale; an axis that recomputes `lo` and `hi` for itself can disagree with
 * the bodies it is labelling, and the disagreement looks like a chart rather than
 * like a bug. One function, both callers.
 */
export interface CandleScale {
  lo: number;
  hi: number;
  /** Price to a y coordinate in the box. */
  y: (price: number) => number;
}

export function candleScale(candles: Candle[], height: number, pad = 2): CandleScale {
  const lo = candles.length === 0 ? 0 : Math.min(...candles.map((c) => c.low));
  const hi = candles.length === 0 ? 0 : Math.max(...candles.map((c) => c.high));
  /*
   * A flat range has no span to normalise against, and dividing by zero puts every
   * coordinate at NaN, which an SVG renders as nothing at all rather than as an
   * error. Drawn down the middle instead, which is the honest picture of a price
   * that has not moved.
   */
  const span = hi - lo;
  return {
    lo,
    hi,
    y: (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - lo) / span) * (height - pad * 2)),
  };
}

/**
 * Evenly spaced price levels for an axis, inclusive of both ends.
 *
 * `count` lines means `count` labels, and a flat range collapses to the single price
 * rather than repeating it: labelling a motionless market with five identical numbers
 * suggests a precision the data does not have.
 */
export function priceTicks(scale: CandleScale, count = 4): number[] {
  if (scale.hi === scale.lo) return [scale.hi];
  const step = (scale.hi - scale.lo) / (count - 1);
  return Array.from({ length: count }, (_, i) => scale.lo + step * i);
}

/**
 * Geometry for drawing candles in a box.
 *
 * Returned as numbers rather than an SVG string so the component can decide what to
 * draw: a wick and a body need different elements, and building a path here would
 * force one shape on every caller.
 */
export function candleLayout(
  candles: Candle[],
  width: number,
  height: number,
  pad = 2,
): Array<{ x: number; w: number; bodyTop: number; bodyH: number; wickTop: number; wickH: number; up: boolean }> {
  if (candles.length === 0) return [];
  const { y } = candleScale(candles, height, pad);

  const slot = width / candles.length;
  const w = Math.max(1, slot * 0.62);

  return candles.map((c, i) => {
    const x = i * slot + (slot - w) / 2;
    const top = y(Math.max(c.open, c.close));
    const bot = y(Math.min(c.open, c.close));
    return {
      x,
      w,
      // A doji has open === close, which is a zero-height body and therefore
      // invisible. One pixel keeps it on the chart as the flat bar it is.
      bodyTop: top,
      bodyH: Math.max(1, bot - top),
      wickTop: y(c.high),
      wickH: Math.max(1, y(c.low) - y(c.high)),
      up: c.close >= c.open,
    };
  });
}
