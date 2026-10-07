/**
 * The price series, built from trades that happened.
 *
 * The launch page already draws the curve, which is what the contract WILL
 * charge. This is what people actually paid, and the two are different questions.
 * The failure worth guarding is the chart drawn from spot instead of from fills:
 * on a steep curve a large buy fills well above spot, and a spot chart hides
 * exactly the cost this project spent two commits learning to disclose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPrice, buildSeries, changeBps, pathFor } from './priceSeries.ts';
import type { Trade } from './chain.ts';

const ONE = 10n ** 18n;

const trade = (over: Partial<Trade> = {}): Trade => ({
  kind: 'buy',
  who: 'inj1someone',
  injIn: ONE,
  injOut: null,
  tokens: 1_000n * ONE,
  fee: ONE / 100n,
  height: 100,
  txHash: 'AAAA',
  ...over,
});

test('a fill price is what moved, divided by what was received', () => {
  // 1 quote for 1000 tokens is 0.001 each.
  assert.equal(fillPrice(trade()), 0.001);
  // A sell prices on what the seller received, after the fee.
  assert.equal(
    fillPrice(trade({ kind: 'sell', injIn: null, injOut: ONE / 2n, tokens: 1_000n * ONE })),
    0.0005,
  );
});

test('a price below 1e-12 is still a price, not a dropped trade', () => {
  /*
   * The case that killed the integer version. It scaled by 1e12 and floored
   * anything smaller to zero, which `buildSeries` then counted as unpriceable and
   * removed, so a cheap token lost every fill from its chart without a word.
   * Measured: scaled gave 0 where float gives 1e-15.
   */
  const p = fillPrice(trade({ injIn: 10n ** 12n, tokens: 10n ** 27n }));
  assert.ok(p !== null, 'a sub-1e-12 price was dropped');
  assert.ok(Math.abs((p as number) - 1e-15) / 1e-15 < 1e-6, `got ${p}`);

  // And it reaches the series rather than the unpriceable count.
  const s = buildSeries([trade({ injIn: 10n ** 12n, tokens: 10n ** 27n })]);
  assert.equal(s.points.length, 1);
  assert.equal(s.unpriceable, 0);
});

test('a sell prices on what was received even when both amounts are present', () => {
  /*
   * Discriminating on purpose. An implementation reading `injIn ?? injOut` gives
   * the same answer whenever a sell carries only `injOut`, which is every fixture
   * built the obvious way, so the mutation passed. A sell that also carries an
   * `injIn` separates the two readings: the seller received `injOut`, and pricing
   * on what the trade cost somebody else is a different number entirely.
   */
  const p = fillPrice(
    trade({ kind: 'sell', injIn: 9n * ONE, injOut: ONE, tokens: 1_000n * ONE }),
  );
  assert.equal(p, 0.001, 'the sell was priced on injIn rather than injOut');
});

test('it survives the eight leading zeros a launch token actually has', () => {
  /*
   * A real figure from this project: 1 quote buys 189,829 tokens, so the price is
   * about 5.3e-6. Computed as `Number(quote) / Number(tokens)` with both at 18
   * decimals this is still fine, but at 24 decimals it is not, and the integer
   * scaling is what makes it independent of that.
   */
  const p = fillPrice(trade({ injIn: ONE, tokens: 189_829n * ONE }));
  assert.ok(p !== null);
  assert.ok(Math.abs((p as number) - 5.2679e-6) < 1e-9, `got ${p}`);
  assert.ok((p as number) > 0, 'a tiny price must not floor to zero');
});

test('an unpriceable trade is counted, never treated as zero', () => {
  /*
   * A chart missing half its trades without saying so lies about the period it
   * covers, and a zero-priced point would drag the whole axis to the floor.
   */
  const s = buildSeries([
    trade(),
    trade({ tokens: null, height: 101 }),
    trade({ injIn: null, height: 102 }),
    trade({ tokens: 0n, height: 103 }),
  ]);
  assert.equal(s.points.length, 1);
  assert.equal(s.unpriceable, 3);
  assert.equal(s.low, 0.001);
});

test('the series runs oldest first, whatever order it arrived in', () => {
  // The tx search returns newest first, which is right for a feed and backwards
  // for a chart. Sorted rather than assumed, because the order is the API's choice.
  const s = buildSeries([
    trade({ height: 300, injIn: 3n * ONE }),
    trade({ height: 100, injIn: 1n * ONE }),
    trade({ height: 200, injIn: 2n * ONE }),
  ]);
  assert.deepEqual(s.points.map((p) => p.height), [100, 200, 300]);
  assert.equal(s.first?.height, 100);
  assert.equal(s.last?.height, 300);
});

test('a buy and a sell at the same size price differently, and that is the spread', () => {
  /*
   * The fee is taken on both legs, so a round trip pays it twice. Smoothing that
   * away would draw a line nobody traded on.
   */
  const buy = fillPrice(trade({ kind: 'buy', injIn: ONE, tokens: 1_000n * ONE })) as number;
  const sell = fillPrice(
    trade({ kind: 'sell', injIn: null, injOut: ONE, tokens: 1_050n * ONE }),
  ) as number;
  assert.ok(sell < buy, 'a seller should receive less per token than a buyer paid');
});

test('graduation is not a trade and carries no price', () => {
  assert.equal(fillPrice(trade({ kind: 'graduate', injIn: null, tokens: null })), null);
  const s = buildSeries([trade({ kind: 'graduate', injIn: null, tokens: null })]);
  assert.equal(s.points.length, 0);
  assert.equal(s.unpriceable, 0, 'a migration is not an unpriceable trade');
});

test('an empty series says so rather than drawing a point at zero', () => {
  const s = buildSeries([]);
  assert.equal(s.points.length, 0);
  assert.equal(s.first, null);
  assert.equal(s.last, null);
  assert.equal(pathFor(s, 100, 40), null);
  assert.equal(changeBps(s), null);
});

test('one trade is not a change', () => {
  /*
   * Reporting 0% from a single fill claims the price has held steady over a period
   * that does not exist. Null is the only honest answer.
   */
  const s = buildSeries([trade()]);
  assert.equal(s.points.length, 1);
  assert.equal(changeBps(s), null);
  assert.equal(pathFor(s, 100, 40), null, 'a single point cannot be a line');
});

test('change is measured first fill to last, in basis points', () => {
  // 0.001 to 0.002 is a double, which is +10000 bps.
  const s = buildSeries([
    trade({ height: 1, injIn: ONE, tokens: 1_000n * ONE }),
    trade({ height: 2, injIn: 2n * ONE, tokens: 1_000n * ONE }),
  ]);
  assert.equal(changeBps(s), 10_000);

  // And down: 0.002 to 0.001 is a halving, which is -5000 bps.
  const down = buildSeries([
    trade({ height: 1, injIn: 2n * ONE, tokens: 1_000n * ONE }),
    trade({ height: 2, injIn: ONE, tokens: 1_000n * ONE }),
  ]);
  assert.equal(changeBps(down), -5_000);
});

test('the path stays inside the box it is given', () => {
  // A chart whose line leaves its viewBox is clipped, and the clipping looks like
  // data rather than like a bug.
  const s = buildSeries([
    trade({ height: 1, injIn: ONE, tokens: 1_000n * ONE }),
    trade({ height: 2, injIn: 5n * ONE, tokens: 1_000n * ONE }),
    trade({ height: 3, injIn: 2n * ONE, tokens: 1_000n * ONE }),
  ]);
  const W = 200;
  const H = 50;
  const d = pathFor(s, W, H, 2);
  assert.ok(d);
  const coords = (d as string).match(/-?\d+\.\d+/g)!.map(Number);
  for (let i = 0; i < coords.length; i += 2) {
    assert.ok(coords[i] >= 0 && coords[i] <= W, `x ${coords[i]} outside 0..${W}`);
    assert.ok(coords[i + 1] >= 0 && coords[i + 1] <= H, `y ${coords[i + 1]} outside 0..${H}`);
  }
});

test('a price that never moved draws down the middle rather than dividing by zero', () => {
  // Three fills at one price: the span is zero and the naive scale is 0/0.
  const s = buildSeries([
    trade({ height: 1 }),
    trade({ height: 2 }),
    trade({ height: 3 }),
  ]);
  assert.equal(s.low, s.high);
  const d = pathFor(s, 100, 40);
  assert.ok(d && !/NaN/.test(d), `path contains NaN: ${d}`);
  assert.equal(changeBps(s), 0, 'a flat price across several fills really is 0%');
});
