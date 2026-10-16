import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activityFor,
  priceSeries,
  uniqueTraders,
  volumeWithin,
  volumeIn,
  volumeIsPartial,
  tradesLabel,
  BLOCKS_PER_DAY,
  countWithin,
} from './launchActivity.ts';
import type { Trade } from './chain.ts';
import { maskComments } from './testing/maskComments.ts';

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
  assert.equal(tradesLabel(null), null);
  /*
   * And `undefined`, which the type said could not happen and which happened: the
   * whole launch grid sits inside one error boundary, so a label helper that throws
   * blanks the board. Nothing that turns a value into a short string should be able
   * to do that.
   */
  assert.equal(tradesLabel(undefined), null);
  /*
   * `null` rather than a sentence, because the only caller is a numeric cell and the
   * board renders an unknown as a dim dot - the same glyph the volume cell beside it
   * uses, which is what the note under the table says those columns mean. Returning
   * prose made that caller write `.replace(' trades', '')` to recover the number, and
   * the leading space in that pattern let `1 trade` through unstripped.
   */
  assert.equal(tradesLabel({ buys: 0, sells: 0, trades: 0 }), '0');
  assert.equal(tradesLabel({ buys: 1, sells: 0, trades: 1 }), '1');
  assert.equal(tradesLabel({ buys: 1200, sells: 671, trades: 1871 }), '1,871');
});

test('the board renders an unread trade count as the dot its note promises', () => {
  /*
   * A unit test on the helper cannot see this: the defect was the CELL, which took a
   * correct label and edited it. So the guard reads the one call site and requires that
   * it falls back to the dim dot rather than printing whatever came back.
   *
   * Rule for the next person: the two unknown columns must render the same glyph. The
   * note under the table is a single sentence about both of them.
   */
  // Masked, so the JSX comment above the cell explaining the defect cannot satisfy or
  // break a guard about the cell.
  const src = maskComments(readFileSync(new URL('../components/LaunchList.tsx', import.meta.url), 'utf8'));

  const cell = /\{tradesLabel\([^)]*\)([\s\S]{0,120}?)\}\n/.exec(src);
  assert.ok(cell, 'LaunchList no longer renders tradesLabel; move this guard to its new home');
  assert.match(
    cell[1],
    /\?\?\s*<span className="dim">·<\/span>/,
    'the trade count cell must fall back to the dim dot, the same unknown the volume cell shows',
  );
  assert.ok(
    !/tradesLabel\([\s\S]{0,80}?\.replace\(/.test(src),
    'the cell is string-editing the label again, which is how "1 trade" escaped the strip',
  );

  // And the note it promises is still there, so the two cannot drift apart silently.
  assert.match(src, /dot in those columns/i);
});

test('a launch that provably never traded has a volume, not a dot', () => {
  /*
   * `volumeIn` at the input level. The live shape it was written for, and the LCD
   * measurements establishing that a zero count is a real zero, are in
   * `board-volume-provenance.test.ts`, which drives `enrichLaunch` against a stubbed
   * node; this is the cheap enumeration of the four input combinations beneath it.
   *
   * Zero trades in a lifetime is zero trades in any window, so the derivation holds
   * with no page and with no height.
   */
  const none = { buys: 0, sells: 0, trades: 0 };
  assert.equal(volumeIn(none, null, 500_000, BLOCKS_PER_DAY), 0n);
  assert.equal(volumeIn(none, null, null, BLOCKS_PER_DAY), 0n);

  /*
   * And the direction that matters is unchanged: nothing known stays null. A failed
   * count beside a failed page must not collapse into a zero, which is the defect this
   * whole module is shaped around.
   */
  assert.equal(volumeIn(null, null, 500_000, BLOCKS_PER_DAY), null);
  assert.equal(volumeIn(null, null, null, BLOCKS_PER_DAY), null);
  // A page we have, with no height, still has no window to sum over.
  assert.equal(volumeIn(null, [t({ height: 499_999 })], null, BLOCKS_PER_DAY), null);

  /*
   * A launch that HAS traded is summed from the page as before. The count is a lifetime
   * total and the volume is a 24h window, so a non-zero count may legitimately sum to
   * zero quote in the window - that must come from the page, never from the count.
   */
  const some = { buys: 3, sells: 0, trades: 3 };
  assert.equal(volumeIn(some, [t({ height: 499_999, injIn: ONE })], 500_000, BLOCKS_PER_DAY), ONE);
  assert.equal(volumeIn(some, [t({ height: 1_000, injIn: ONE })], 500_000, BLOCKS_PER_DAY), 0n);
  assert.equal(volumeIn(some, null, 500_000, BLOCKS_PER_DAY), null);

  /*
   * And the board has to go THROUGH it. `enrichLaunch` is the only producer of
   * `volume24h` and it does three network reads, so no unit test reaches it - which
   * means every assertion above stays green if that one line reverts to the inline
   * `trades === null ? null : volumeWithin(...)` it came from. A correct resolver
   * nothing calls is this codebase's most repeated defect, so the guard is that
   * `volumeWithin` is reached only from inside `volumeIn`.
   */
  // Comments masked, because the docblock above `volumeIn` quotes the line it replaced.
  const code = maskComments(readFileSync(new URL('./launchActivity.ts', import.meta.url), 'utf8'));
  assert.match(code, /volume24h: volumeIn\(/, 'enrichLaunch must resolve volume through volumeIn');
  assert.equal(
    (code.match(/\bvolumeWithin\(/g) ?? []).length,
    2,
    'volumeWithin should appear twice: its declaration, and the one call inside volumeIn',
  );
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

test('demo trade counts are never negative, whatever the curve address', async () => {
  // A signed shift on an unsigned seed put "-16 trades" on a demo card.
  const prev = process.env.NEXT_PUBLIC_DEMO;
  process.env.NEXT_PUBLIC_DEMO = '1';
  try {
    for (let i = 0; i < 300; i++) {
      const a = await activityFor(`inj1demo${'z'.repeat(i % 40)}${i}curve`);
      assert.ok(a.buys >= 0 && a.sells >= 0 && a.trades === a.buys + a.sells, JSON.stringify(a));
    }
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_DEMO;
    else process.env.NEXT_PUBLIC_DEMO = prev;
  }
});

test('the 24h trade count is a count, so it crosses pairs', () => {
  /*
   * WHY TRENDING RANKS ON THIS AND NOT ON VOLUME. Volume is denominated in each
   * launch's quote, so ranking an INJ launch against a USDC one by volume ranks
   * amounts of different assets, and there is no price oracle here to convert with.
   * A trade is a trade in any pair.
   *
   * It is also the honest meaning of "trending": one enormous trade is not trending,
   * forty small ones are.
   */
  const now = 300_000;
  const trades = [
    t({ height: now - 5 }),
    t({ height: now - 10, kind: 'sell', injIn: null, injOut: ONE }),
    t({ height: now - BLOCKS_PER_DAY - 1 }), // outside the window
    t({ height: now - 20, kind: 'graduate' as Trade['kind'], injIn: null, tokens: null }),
  ];
  // Two trades in the window; graduation is not a trade and the old one is out.
  assert.equal(countWithin(trades, now, BLOCKS_PER_DAY), 2);
});

test('an unknown height ranks last rather than refusing to rank', () => {
  /*
   * Deliberately different from `volumeWithin`, which returns null. Volume is shown
   * to a reader, where zero and unmeasured must not look alike. This feeds a
   * RANKING, where the only sensible place for a launch we could not measure is the
   * bottom, and 0 puts it there.
   */
  assert.equal(countWithin([t({})], null, BLOCKS_PER_DAY), 0);
});
