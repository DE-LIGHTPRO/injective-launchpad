import test from 'node:test';
import assert from 'node:assert/strict';
import { toCandles, candleLayout } from './candles.ts';
import type { Series, PricePoint } from './priceSeries.ts';

const pt = (height: number, price: number): PricePoint =>
  ({ height, price, side: 'buy', txHash: `h${height}` });

const series = (points: PricePoint[]): Series => ({
  points,
  first: points[0] ?? null,
  last: points[points.length - 1] ?? null,
  low: points.length ? Math.min(...points.map((p) => p.price)) : 0,
  high: points.length ? Math.max(...points.map((p) => p.price)) : 0,
  unpriceable: 0,
});

test('open and close are the first and last fills, not the low and high', () => {
  /*
   * The whole point of a candle. Taking min as open and max as close would draw
   * every bucket as rising, which looks like a chart and is a different claim.
   */
  const c = toCandles(series([pt(1, 5), pt(2, 9), pt(3, 2), pt(4, 7)]), 1);
  assert.equal(c.length, 1);
  assert.equal(c[0].open, 5);
  assert.equal(c[0].close, 7);
  assert.equal(c[0].high, 9);
  assert.equal(c[0].low, 2);
  assert.equal(c[0].trades, 4);
});

test('a bucket with no trades is dropped, not carried forward', () => {
  /*
   * Most charting carries the last close across a gap. On a launchpad a token can
   * sit untouched for hours, and a candle drawn there invents an open, high, low and
   * close for a period with no trades in it, making an illiquid token look stable.
   */
  const c = toCandles(series([pt(1, 5), pt(1000, 6)]), 10);
  assert.equal(c.length, 2, 'empty buckets were materialised');
  assert.ok(c.every((x) => x.trades > 0));
});

test('trades inside one block still bucket rather than vanishing', () => {
  // The span is derived from the range, which is zero here; it must floor at 1.
  const c = toCandles(series([pt(7, 1), pt(7, 2), pt(7, 3)]), 24);
  assert.equal(c.length, 1);
  assert.equal(c[0].trades, 3);
  assert.equal(c[0].open, 1);
  assert.equal(c[0].close, 3);
});

test('an empty series draws nothing rather than throwing', () => {
  assert.deepEqual(toCandles(series([]), 24), []);
  assert.deepEqual(candleLayout([], 100, 50), []);
});

test('a flat market is drawn down the middle, not as NaN', () => {
  /*
   * Dividing by a zero range puts every coordinate at NaN, which an SVG renders as
   * nothing at all rather than as an error: the chart silently disappears.
   */
  const c = toCandles(series([pt(1, 4), pt(2, 4)]), 2);
  const layout = candleLayout(c, 100, 50);
  assert.ok(layout.length > 0);
  for (const l of layout) {
    for (const v of [l.x, l.w, l.bodyTop, l.bodyH, l.wickTop, l.wickH]) {
      assert.ok(Number.isFinite(v), 'a non-finite coordinate reached the chart');
    }
  }
});

test('a doji keeps a visible body', () => {
  // open === close is a zero-height rect, which is invisible. It must still show as
  // the flat bar it is.
  const c = toCandles(series([pt(1, 5)]), 1);
  const [l] = candleLayout(c, 100, 50);
  assert.ok(l.bodyH >= 1, 'a doji rendered as nothing');
});

test('direction is close against open', () => {
  const up = toCandles(series([pt(1, 1), pt(2, 2)]), 1);
  const down = toCandles(series([pt(1, 2), pt(2, 1)]), 1);
  assert.equal(candleLayout(up, 10, 10)[0].up, true);
  assert.equal(candleLayout(down, 10, 10)[0].up, false);
});
