import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCandles,
  candleLayout,
  candleScale,
  priceTicks,
  defaultTimeframe,
  timeframeSeconds,
  TIMEFRAMES,
} from './candles.ts';
import type { PricePoint, Series } from './priceSeries.ts';

/**
 * Candles are wall-clock intervals, and the chart must not invent what it cannot see.
 *
 * These used to bucket by BLOCK HEIGHT, because a note claimed height was the only
 * ordering the chain gave a trade. It was wrong: `tx_responses[].timestamp` is an
 * RFC 3339 block time and the code was discarding it. The axis read "by block",
 * which is unreadable on a trading surface, and a timeframe selector was impossible.
 */

const ONE = 10n ** 18n;

/** A fill at `t` seconds past an arbitrary epoch, so the maths is readable. */
const T0 = 1_760_000_000;
const pt = (tOffset: number, price: number, quote = ONE, height = 0): PricePoint => ({
  height: height || 1000 + tOffset,
  time: T0 + tOffset,
  price,
  side: 'buy',
  quote,
  txHash: `0x${tOffset}`,
});

const series = (points: PricePoint[]): Series => ({
  points,
  first: points[0] ?? null,
  last: points[points.length - 1] ?? null,
  low: points.length ? Math.min(...points.map((p) => p.price)) : 0,
  high: points.length ? Math.max(...points.map((p) => p.price)) : 0,
  unpriceable: 0,
});

test('open and close are the first and last fills, not the low and high', () => {
  const c = toCandles(series([pt(0, 5), pt(10, 9), pt(20, 2), pt(30, 7)]), 300);
  assert.equal(c.length, 1);
  assert.equal(c[0].open, 5);
  assert.equal(c[0].close, 7);
  assert.equal(c[0].high, 9);
  assert.equal(c[0].low, 2);
  assert.equal(c[0].trades, 4);
});

test('buckets land on round interval boundaries', () => {
  /*
   * A 5m candle starts at :00, :05, :10, the way every other chart's does, rather
   * than at whenever the first trade happened. Two launches on the same timeframe
   * then have candles that line up with each other and with the clock.
   */
  const c = toCandles(series([pt(0, 1), pt(400, 2)]), 300);
  assert.equal(c.length, 2);
  assert.equal(c[0].time % 300, 0, 'a bucket does not start on a 5m boundary');
  assert.equal(c[1].time % 300, 0, 'a bucket does not start on a 5m boundary');
  /*
   * A WHOLE NUMBER OF INTERVALS APART, not exactly one. Two fills 400s apart land
   * either one or two 5m buckets apart depending where the clock boundary falls
   * between them, and that is the correct behaviour: the bucket is a wall-clock
   * slot, not an offset from the first trade. Asserting "exactly 300" was my own
   * arithmetic error and would have been "fixed" by aligning buckets to the first
   * trade, which is the thing this test exists to prevent.
   */
  assert.equal((c[1].time - c[0].time) % 300, 0);
  assert.ok(c[1].time > c[0].time);
});

test('an interval with no trades is dropped, not carried forward', () => {
  /*
   * Most charting carries the last close across a gap. On a launchpad a token can
   * sit untouched for hours, and a candle drawn there invents an open, high, low and
   * close for a period with no trades in it, making an illiquid token look stable.
   */
  const c = toCandles(series([pt(0, 5), pt(3_600, 6)]), 300);
  assert.equal(c.length, 2, 'empty intervals were materialised');
  assert.ok(c.every((x) => x.trades > 0));
});

test('an empty interval still takes its slot on the chart', () => {
  /*
   * The other half of the same rule. Dropping the candle is right; packing the
   * remaining ones shoulder to shoulder would tell a reader trading was continuous
   * through a gap it was not. The two candles above are an hour apart on a 5m
   * interval, so they must be twelve slots apart, not adjacent.
   */
  const c = toCandles(series([pt(0, 5), pt(3_600, 6)]), 300);
  const l = candleLayout(c, 1200, 100, 300);
  assert.equal(l.length, 2);
  const slots = (l[1].cx - l[0].cx) / l[0].slot;
  assert.ok(Math.abs(slots - 12) < 0.01, `candles are ${slots} slots apart, expected 12`);
});

test('trades in the same second still bucket rather than vanishing', () => {
  const c = toCandles(series([pt(0, 1, ONE, 7), pt(0, 2, ONE, 8), pt(0, 3, ONE, 9)]), 60);
  assert.equal(c.length, 1);
  assert.equal(c[0].trades, 3);
  // Height breaks the tie inside a bucket: it is the order the chain applied them.
  assert.equal(c[0].open, 1);
  assert.equal(c[0].close, 3);
});

test('a point with no block time is skipped, never dated to 1970', () => {
  /*
   * Placing it at zero would stretch the axis across fifty-odd years and squash
   * every real candle into one pixel at the right edge.
   */
  const undated: PricePoint = { ...pt(0, 5), time: 0 };
  const c = toCandles(series([undated, pt(60, 6), pt(70, 7)]), 60);
  assert.ok(c.every((x) => x.time > T0 - 1), 'an undated point reached the chart');
  assert.equal(c.reduce((n, x) => n + x.trades, 0), 2);
});

test('volume is the quote that moved, summed over the interval', () => {
  const c = toCandles(series([pt(0, 1, 3n * ONE), pt(10, 2, 2n * ONE)]), 300);
  assert.equal(c[0].volume, 5n * ONE);
});

test('an empty series draws nothing rather than throwing', () => {
  assert.deepEqual(toCandles(series([]), 300), []);
  assert.deepEqual(candleLayout([], 100, 50, 300), []);
  const s = candleScale([], 50);
  assert.equal(s.y(0), 25, 'an empty scale must still be a function');
});

test('a flat market is drawn down the middle, not as NaN', () => {
  const c = toCandles(series([pt(0, 5), pt(10, 5)]), 300);
  const l = candleLayout(c, 100, 50, 300);
  assert.ok(Number.isFinite(l[0].bodyTop), `bodyTop is ${l[0].bodyTop}`);
  assert.ok(Number.isFinite(l[0].wickTop), `wickTop is ${l[0].wickTop}`);
});

test('a doji keeps a visible body', () => {
  const c = toCandles(series([pt(0, 5), pt(10, 9), pt(20, 5)]), 300);
  const l = candleLayout(c, 100, 50, 300);
  assert.ok(l[0].bodyH >= 1, 'a zero-height body is an invisible candle');
});

test('direction is close against open', () => {
  const up = toCandles(series([pt(0, 1), pt(10, 2)]), 300);
  const down = toCandles(series([pt(0, 2), pt(10, 1)]), 300);
  assert.equal(candleLayout(up, 100, 50, 300)[0].up, true);
  assert.equal(candleLayout(down, 100, 50, 300)[0].up, false);
});

test('the scale leaves headroom, so the extremes are not welded to the edges', () => {
  const c = toCandles(series([pt(0, 10), pt(10, 20)]), 300);
  const s = candleScale(c, 100);
  assert.ok(s.lo < 10, 'the low sits on the bottom edge');
  assert.ok(s.hi > 20, 'the high sits on the top edge');
});

test('the axis and the candles share one scale', () => {
  /*
   * `priceTicks` reads the scale rather than recomputing lo and hi, so a label can
   * never sit at a different height from the price it names. A disagreement here
   * looks like a chart, not like a bug, which is why it is asserted.
   */
  const c = toCandles(series([pt(0, 1), pt(10, 3)]), 300);
  const s = candleScale(c, 200);
  const ticks = priceTicks(s, 5);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0], s.lo);
  assert.equal(ticks[4], s.hi);
  // `candleScale` pads by 2 at each end by default, so the extremes land at
  // `height - pad` and `pad` rather than flush against 200 and 0.
  assert.ok(Math.abs(s.y(ticks[0]) - 198) < 1, `lowest tick at ${s.y(ticks[0])}`);
  assert.ok(Math.abs(s.y(ticks[4]) - 2) < 1, `highest tick at ${s.y(ticks[4])}`);
});

test('a flat range collapses to one tick rather than five identical ones', () => {
  const s = candleScale(toCandles(series([pt(0, 5)]), 300), 100);
  assert.deepEqual(priceTicks(s, 5), [s.hi]);
});

test('bodies are capped, so a three-candle chart is not three billboards', () => {
  /*
   * Measured on the live page before this: 3 candles across a 560-wide plot gave
   * bodies 103 pixels wide, one of them a solid red block most of the chart's
   * height. It was a correct drawing of the data and it looked nothing like a chart.
   */
  const c = toCandles(series([pt(0, 1), pt(300, 2), pt(600, 3)]), 300);
  const l = candleLayout(c, 720, 230, 300);
  assert.ok(l.every((x) => x.w <= 9), `a body is ${Math.max(...l.map((x) => x.w))} wide`);
});

test('the default interval suits the data instead of always being the smallest', () => {
  // Minutes old: the finest interval, or the whole launch is one candle.
  const young = series([pt(0, 1), pt(30, 2), pt(90, 3)]);
  assert.equal(defaultTimeframe(young), '1m');

  // A week old: a 1m chart would be ten thousand slots wide.
  const old = series([pt(0, 1), pt(7 * 86_400, 2)]);
  assert.equal(defaultTimeframe(old), '1d');

  // Every answer is one of the offered intervals, or the selector cannot show it.
  for (const s of [young, old, series([pt(0, 1), pt(5_000, 2)])]) {
    assert.ok(TIMEFRAMES.some((t) => t.id === defaultTimeframe(s)));
  }
});

test('the default never produces an unreadable number of slots', () => {
  /*
   * The property, rather than the specific answer: whatever interval is chosen, the
   * span divided by it must be a chart a person can look at.
   */
  for (const spanSeconds of [60, 600, 3_600, 86_400, 30 * 86_400, 365 * 86_400]) {
    const s = series([pt(0, 1), pt(spanSeconds, 2)]);
    const slots = spanSeconds / timeframeSeconds(defaultTimeframe(s));
    assert.ok(slots <= 40 || defaultTimeframe(s) === '1d', `${spanSeconds}s gave ${slots} slots`);
  }
});

test('an empty series still yields a usable default', () => {
  assert.ok(TIMEFRAMES.some((t) => t.id === defaultTimeframe(series([]))));
});

test('"All" fits the whole history rather than being a fixed interval', () => {
  /*
   * It is an instruction, not a bucket size: whatever the launch's span, All has to
   * produce a chart a person can look at. A fixed seconds value in the table would
   * give a week-old launch ten thousand slots and a minutes-old one a single candle.
   */
  for (const spanSeconds of [120, 3_600, 86_400, 30 * 86_400]) {
    const s = series([pt(0, 1), pt(spanSeconds, 2)]);
    const secs = timeframeSeconds('all', s, 60);
    const slots = spanSeconds / secs;
    assert.ok(slots <= 61 && slots >= 1, `${spanSeconds}s gave ${slots} slots`);
  }
});

test('"All" is never chosen automatically', () => {
  /*
   * The default has to be a real, nameable interval. Landing on All would leave the
   * reader unable to tell what a candle covers, and the label would not say.
   */
  for (const spanSeconds of [60, 3_600, 86_400, 365 * 86_400]) {
    assert.notEqual(defaultTimeframe(series([pt(0, 1), pt(spanSeconds, 2)])), 'all');
  }
});

test('"All" with too little history falls back rather than dividing by zero', () => {
  assert.ok(timeframeSeconds('all', series([]), 60) > 0);
  assert.ok(timeframeSeconds('all', series([pt(0, 1)]), 60) > 0);
  assert.ok(timeframeSeconds('all', undefined, 60) > 0);
});
