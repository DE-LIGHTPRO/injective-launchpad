import type { PricePoint, Series } from './priceSeries.ts';

/**
 * Fill prices bucketed into candles, on a chosen timeframe.
 *
 * IT USED TO BUCKET BY BLOCK HEIGHT, and the axis read "by block". The note
 * defending that said height was "the only ordering this chain gives a trade", which
 * was never true: `/cosmos/tx/v1beta1/txs` returns an RFC 3339 `timestamp` on every
 * transaction and this code was discarding it. Nobody re-measured the claim, so a
 * trading surface shipped with an axis denominated in block numbers and no way to
 * change the interval. Rule: a documented limitation that was never re-tested reads
 * as a live constraint.
 *
 * A candle is now a wall-clock interval, which is what a timeframe selector means
 * and what every chart a trader has ever used does.
 *
 * EMPTY INTERVALS ARE DROPPED from the data and still TAKE THEIR SLOT on the chart.
 * A gap means nobody traded, and a candle drawn across it invents an open, high, low
 * and close for a period with no trades in it; but packing the candles that do exist
 * shoulder to shoulder tells a reader trading was continuous when it was not. So the
 * candle is absent and the space is real.
 */

/** The intervals offered, in seconds, smallest first. */
export const TIMEFRAMES = [
  { id: '1m', label: '1m', seconds: 60 },
  { id: '5m', label: '5m', seconds: 300 },
  { id: '15m', label: '15m', seconds: 900 },
  { id: '1h', label: '1H', seconds: 3_600 },
  { id: '4h', label: '4H', seconds: 14_400 },
  { id: '1d', label: '1D', seconds: 86_400 },
  /*
   * "All" is not an interval, it is an instruction: fit the launch's whole history
   * into one readable chart. The seconds here are a placeholder the resolver never
   * uses; `timeframeSeconds` is given the series for this id and derives a span
   * from it. Listed with the rest so the control is one row of buttons, which is
   * where a reader looks for it.
   */
  { id: 'all', label: 'All', seconds: 0 },
] as const;

export type TimeframeId = (typeof TIMEFRAMES)[number]['id'];

/**
 * Seconds per candle for an interval.
 *
 * `all` has no fixed answer, so it takes the series and divides its span into a
 * readable number of candles, rounded UP to a whole second. A caller that passes no
 * series for `all` gets the daily interval, which is the safe wrong answer: too
 * coarse rather than ten thousand slots wide.
 */
export function timeframeSeconds(id: TimeframeId, series?: Series, want = 60): number {
  if (id !== 'all') return TIMEFRAMES.find((t) => t.id === id)?.seconds ?? 300;
  const pts = series?.points.filter((p) => p.time > 0) ?? [];
  if (pts.length < 2) return 60;
  const span = pts[pts.length - 1].time - pts[0].time;
  return Math.max(1, Math.ceil(span / want));
}

export interface Candle {
  /** Start of the interval, UNIX seconds. Buckets are `intervalSeconds` wide. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote that moved in the interval, base units. */
  volume: bigint;
  /** Trades in the interval. Zero never appears: an empty interval is omitted. */
  trades: number;
}

/**
 * Group a series into candles of a fixed wall-clock interval.
 *
 * Points with no block time are SKIPPED rather than placed at zero, which would put
 * them at 1970 and stretch the axis across half a century. In practice every trade
 * read from the chain has one; a point without is a parse failure, and dropping it
 * is visible as a shorter chart rather than as a corrupted one.
 */
export function toCandles(series: Series, intervalSeconds: number): Candle[] {
  const pts = series.points.filter((p) => p.time > 0);
  if (pts.length === 0 || intervalSeconds <= 0) return [];

  const buckets = new Map<number, PricePoint[]>();
  for (const p of pts) {
    // Floored to the interval, so buckets land on round boundaries the way every
    // other chart's do: a 5m candle starts at :00, :05, :10.
    const slot = Math.floor(p.time / intervalSeconds) * intervalSeconds;
    const list = buckets.get(slot) ?? [];
    list.push(p);
    buckets.set(slot, list);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, group]) => {
      // Within a bucket, chronological, so open and close are the first and last
      // FILLS rather than the min and max. Two trades in one block share a time, so
      // height breaks the tie: it is the order the chain actually applied them in.
      const ordered = [...group].sort((a, b) => a.time - b.time || a.height - b.height);
      const prices = ordered.map((g) => g.price);
      return {
        time: slot,
        open: prices[0],
        close: prices[prices.length - 1],
        high: Math.max(...prices),
        low: Math.min(...prices),
        volume: ordered.reduce((sum, g) => sum + g.quote, 0n),
        trades: ordered.length,
      };
    });
}

/**
 * The interval that suits this data, when the reader has not chosen one.
 *
 * WHY NOT JUST THE SMALLEST. A launch minutes old has every trade inside one minute,
 * so 1m gives a single candle; a launch a week old on 1m spans ten thousand intervals
 * and squeezes a few dozen candles against one edge. The default aims for a chart
 * with enough candles to read and few enough to tell apart. The reader can override
 * it, which is the entire point of a timeframe selector.
 */
export function defaultTimeframe(series: Series, want = 40): TimeframeId {
  const pts = series.points.filter((p) => p.time > 0);
  if (pts.length === 0) return '5m';
  const span = pts[pts.length - 1].time - pts[0].time;
  if (span <= 0) return '1m';
  // The smallest interval whose slot count across the span fits the target.
  for (const tf of TIMEFRAMES) {
    // `all` is a reader's instruction rather than an interval, so it is never the
    // automatic answer: the automatic answer has to be a real, nameable bucket.
    if (tf.id !== 'all' && span / tf.seconds <= want) return tf.id;
  }
  return '1d';
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
  if (candles.length === 0) return { lo: 0, hi: 0, y: () => height / 2 };
  const rawLo = Math.min(...candles.map((c) => c.low));
  const rawHi = Math.max(...candles.map((c) => c.high));
  /*
   * Headroom above and below, so the highest wick is not welded to the top edge and
   * the lowest to the bottom. Every chart does this; without it the extremes read as
   * clipped rather than as extremes.
   */
  const room = (rawHi - rawLo) * 0.08;
  const lo = rawLo - room;
  const hi = rawHi + room;
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

export interface CandleGeometry {
  /** Left edge of the body, and the centre of the slot is `x + w / 2`. */
  x: number;
  w: number;
  /** Centre of the slot, for the wick and for hit-testing a hover. */
  cx: number;
  /** Full slot width, so a hover target can cover the gaps too. */
  slot: number;
  bodyTop: number;
  bodyH: number;
  wickTop: number;
  wickH: number;
  /** This candle's volume as a fraction of the largest on screen, 0 to 1. */
  volFrac: number;
  up: boolean;
  candle: Candle;
}

/**
 * Geometry for drawing candles in a box.
 *
 * SLOTS ARE EVERY INTERVAL IN THE RANGE, not every candle that exists. Candles packed
 * shoulder to shoulder regardless of the gaps between them tell a reader that trading
 * was continuous when it was not. An empty interval takes its slot and draws nothing,
 * which is what a real chart does and what makes a quiet stretch look quiet.
 *
 * Returned as numbers rather than an SVG string so the component can decide what to
 * draw: a wick, a body and a volume bar are different elements, and building one path
 * here would force a shape on every caller.
 */
export function candleLayout(
  candles: Candle[],
  width: number,
  height: number,
  intervalSeconds: number,
  pad = 2,
): CandleGeometry[] {
  if (candles.length === 0 || intervalSeconds <= 0) return [];
  const { y } = candleScale(candles, height, pad);

  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  const spanSlots = Math.max(1, Math.round((last - first) / intervalSeconds) + 1);
  /*
   * Capped, because a long quiet stretch would otherwise make every candle
   * sub-pixel. Past the cap the slots collapse to one per candle, which overstates
   * continuity and is the lesser fault: a chart nobody can see shows nothing at all.
   * The timeframe selector is how a reader escapes this, which is another reason it
   * had to exist.
   */
  const useGaps = spanSlots <= width / 2;
  const count = useGaps ? spanSlots : candles.length;

  const slot = width / count;
  /*
   * NORMAL CANDLE PROPORTIONS, and capped. On a dense chart the slot governs and
   * bodies come out a few pixels wide, which is what a candle chart looks like; the
   * cap only bites when a launch has a handful of candles, and without one those
   * drew as billboards (measured: three bodies 103 pixels wide, one of them a solid
   * block most of the chart's height). Nine keeps a sparse chart looking like the
   * same instrument as a busy one rather than like a bar chart.
   */
  const w = Math.max(1, Math.min(slot * 0.7, 9));

  const maxVol = candles.reduce((m, c) => (c.volume > m ? c.volume : m), 0n);

  return candles.map((c, i) => {
    const index = useGaps ? Math.round((c.time - first) / intervalSeconds) : i;
    const x = index * slot + (slot - w) / 2;
    const top = y(Math.max(c.open, c.close));
    const bot = y(Math.min(c.open, c.close));
    return {
      x,
      w,
      cx: index * slot + slot / 2,
      slot,
      // A doji has open === close, which is a zero-height body and therefore
      // invisible. One pixel keeps it on the chart as the flat bar it is.
      bodyTop: top,
      bodyH: Math.max(1, bot - top),
      wickTop: y(c.high),
      wickH: Math.max(1, y(c.low) - y(c.high)),
      /*
       * Against the LARGEST bar on screen, not a fixed scale. Volume has no natural
       * ceiling, so the only readable normalisation is relative, and the pane is
       * deliberately unlabelled for that reason: it shows which intervals were busy,
       * not how much was traded. The figure itself is in the panel below the chart.
       */
      volFrac: maxVol === 0n ? 0 : Number((c.volume * 1000n) / maxVol) / 1000,
      up: c.close >= c.open,
      candle: c,
    };
  });
}
