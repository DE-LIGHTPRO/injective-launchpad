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
  // At least 1, so a burst of trades inside a single block still buckets.
  const span = Math.max(1, Math.ceil((last - first + 1) / want));

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
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  /*
   * A flat range has no span to normalise against, and dividing by zero puts every
   * coordinate at NaN, which an SVG renders as nothing at all rather than as an
   * error. Drawn down the middle instead, which is the honest picture of a price
   * that has not moved.
   */
  const span = hi - lo;
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - lo) / span) * (height - pad * 2));

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
