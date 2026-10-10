import test from 'node:test';
import assert from 'node:assert/strict';
import {
  priceSeries,
  uniqueTraders,
  volumeWithin,
  volumeIsPartial,
  tradesLabel,
  BLOCKS_PER_DAY,
} from './launchActivity.ts';
import type { Trade } from './chain.ts';

const ONE = 10n ** 18n;
const t = (p: Partial<Trade>): Trade =>
  ({
    kind: 'buy',
    who: 'inj1a',
    height: 1_000,
    txHash: 'x',
    injIn: ONE,
    injOut: null,
    tokens: 1000n * ONE,
    fee: 0n,
    ...p,
  }) as Trade;

test('traders are counted, not holders', () => {
  /*
   * The name carries the claim. Someone who bought and sold out is counted and holds
   * nothing, and someone who received tokens in a bank send never appears at all,
   * because a bank send on Injective runs no contract code. This is why the figure is
   * not labelled "holders" anywhere: `denom_owners` answers 501 Not Implemented on
   * this chain and no amount of trade history reconstructs it.
   */
  const trades = [
    t({ who: 'inj1a' }),
    t({ who: 'inj1b', kind: 'sell', injIn: null, injOut: ONE }),
    t({ who: 'inj1a' }),
    t({ who: null }),
  ];
  assert.equal(uniqueTraders(trades), 2);
});

test('an unknown height makes the window unknown, never zero', () => {
  // A sum with no window is a different number wearing the label "24h".
  assert.equal(volumeWithin([t({})], null, BLOCKS_PER_DAY), null);
});

test('only trades inside the window are summed', () => {
  const now = 200_000;
  const trades = [
    t({ height: now - 10, injIn: 2n * ONE }),
    t({ height: now - BLOCKS_PER_DAY - 1, injIn: 99n * ONE }), // older than the window
    t({ height: now - 5, kind: 'sell', injIn: null, injOut: 3n * ONE }),
  ];
  assert.equal(volumeWithin(trades, now, BLOCKS_PER_DAY), 5n * ONE);
});

test('graduation is not a trade and carries no quote', () => {
  const g = t({ kind: 'graduate' as Trade['kind'], injIn: null, injOut: null });
  assert.equal(volumeWithin([g], 1_000, BLOCKS_PER_DAY), 0n);
});

test('a full page inside the window is reported as partial', () => {
  /*
   * The sum is bounded by what was fetched. If the oldest trade returned is still
   * inside the window there may be more beyond the page, so the figure is a floor.
   * Printing it bare would understate a busy launch and read as exact.
   */
  const now = 500_000;
  const full = Array.from({ length: 20 }, (_, i) => t({ height: now - i }));
  assert.equal(volumeIsPartial(full, 20, now, BLOCKS_PER_DAY), true);
  // A short page means the history ran out, so the sum is complete.
  assert.equal(volumeIsPartial(full.slice(0, 5), 20, now, BLOCKS_PER_DAY), false);
  // A full page that is entirely OLDER than the window is complete for this window.
  const old = Array.from({ length: 20 }, (_, i) => t({ height: now - BLOCKS_PER_DAY - 1 - i }));
  assert.equal(volumeIsPartial(old, 20, now, BLOCKS_PER_DAY), false);
});

test('a failed count reads as unavailable, never as zero', () => {
  // Zero is a real and common answer on a new board. A failed read rendering as
  // "0 trades" is indistinguishable from a launch nobody has touched.
  assert.equal(tradesLabel(null), 'trades unavailable');
  /*
   * And `undefined`, which the type said could not happen and which happened: the
   * whole launch grid sits inside one error boundary, so a label helper that throws
   * blanks the board. Nothing that turns a value into a short string should be able
   * to do that.
   */
  assert.equal(tradesLabel(undefined), 'trades unavailable');
  assert.equal(tradesLabel({ buys: 0, sells: 0, trades: 0 }), '0 trades');
  assert.equal(tradesLabel({ buys: 1, sells: 0, trades: 1 }), '1 trade');
  assert.equal(tradesLabel({ buys: 1200, sells: 671, trades: 1871 }), '1,871 trades');
});

test('the price line is built from fills, oldest first', () => {
  /*
   * `listTrades` returns newest first and a chart reads left to right in time, so the
   * series is reversed. Getting this backwards draws every launch as its own mirror
   * image, which looks like a plausible chart and is the exact opposite of the truth.
   */
  const trades = [
    t({ height: 3, injIn: 3n * ONE, tokens: 1n * ONE }), // newest, price 3
    t({ height: 2, injIn: 2n * ONE, tokens: 1n * ONE }),
    t({ height: 1, injIn: 1n * ONE, tokens: 1n * ONE }), // oldest, price 1
  ];
  assert.deepEqual(priceSeries(trades), [1, 2, 3]);
});

test('a trade with no tokens is left out rather than priced as infinity', () => {
  // Graduation emits no token amount. Dividing by it yields Infinity, which an SVG
  // renders as a path that silently disappears rather than as an error.
  const series = priceSeries([
    t({ height: 2, kind: 'graduate' as Trade['kind'], injIn: null, tokens: null }),
    t({ height: 1, injIn: 2n * ONE, tokens: 1n * ONE }),
  ]);
  assert.deepEqual(series, [2]);
  assert.ok(series.every(Number.isFinite), 'a non-finite price reached the series');
});

test('a sell is priced the same way a buy is', () => {
  // Both sides are quote over tokens. Reading only `injIn` would drop every sell and
  // draw a line made of half the market.
  assert.deepEqual(
    priceSeries([t({ kind: 'sell', injIn: null, injOut: 5n * ONE, tokens: 1n * ONE })]),
    [5],
  );
});
