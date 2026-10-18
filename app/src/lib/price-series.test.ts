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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fillPrice, buildSeries, changeBps } from './priceSeries.ts';
import type { Trade } from './chain.ts';

const ONE = 10n ** 18n;

const trade = (over: Partial<Trade> = {}): Trade => ({
  kind: 'buy',
  who: 'inj1someone',
  time: 0,
  injIn: ONE,
  injOut: null,
  // A buy the curve absorbed whole, which is what every assertion below means by
  // a buy. The partial-fill cases pass their own refund.
  refund: 0n,
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

/*
 * The `pathFor` tests went with the function. It drew the fill series as a line and
 * the launch page moved to candles; nothing called it, and four tests passing on an
 * unreachable function is the false confidence this project keeps finding rather
 * than evidence of coverage.
 */

/*
 * ------------------------------------------------------------------------------------
 * AND THE QUOTE'S SCALE, which both entry points default to 18.
 *
 * 18 is right for an INJ launch and wrong by a factor of 1e12 for a 6-decimal one, so
 * a bare `fillPrice(t)` draws a stablecoin launch's whole chart a trillion times too
 * low and nothing throws. Both production callers pass the launch's own decimals today;
 * this is what stops the third one from not bothering.
 *
 * The defaults stay rather than being made required: fifteen assertions above are about
 * the arithmetic and read better on an 18/18 pair, and the hazard is at the call site,
 * which is where this looks for it. The tests themselves are excluded by walking only
 * non-test sources.
 * ------------------------------------------------------------------------------------
 */

test('no production caller prices a fill in the default quote', () => {
  const SRC = join(import.meta.dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(SRC);

  const sites: string[] = [];
  const bare: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/\/\/[^\n]*/g, '');
    const rel = file.slice(SRC.length + 1);
    // The definitions themselves carry the defaults and are not call sites.
    if (rel === 'lib/priceSeries.ts') continue;
    for (const m of src.matchAll(/\b(fillPrice|buildSeries)\(([^)]*)\)/g)) {
      sites.push(`${rel}: ${m[1]}`);
      // Two arguments, the second of which is not a literal number.
      if (!/,\s*[A-Za-z_$]/.test(m[2])) bare.push(`${rel}: ${m[1]}(${m[2].replace(/\s+/g, ' ')})`);
    }
  }
  // Anti-vacuity: a rename would otherwise leave this passing over nothing.
  assert.ok(sites.length >= 2, `expected the series to be built somewhere, found ${sites.length} call sites`);
  assert.deepEqual(bare, [], 'a fill is priced at the default 18 decimals rather than the launch\u2019s quote');
});
