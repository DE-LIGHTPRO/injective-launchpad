/**
 * The one holder figure this chain can produce, and the care it needs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCreatorHolding, firstBlockShare, UNKNOWN_HOLDING } from './creatorHolding.ts';

const ONE = 10n ** 18n;

test('an unread balance is never rendered as zero', () => {
  /*
   * The single most reassuring claim this page can make is that the creator holds
   * nothing, and an unreachable LCD must never make it by accident. `null` is "not
   * read"; zero is a measurement.
   */
  const d = describeCreatorHolding(UNKNOWN_HOLDING);
  assert.match(d.text, /could not be read/);
  assert.ok(!/0(\.0)?%/.test(d.text), 'an unread balance rendered as a percentage');
});

test('zero is reported as zero AT THIS ADDRESS, not as "the creator sold"', () => {
  /*
   * A creator holding nothing may have sold, or may never have bought. Those are
   * opposite facts and a balance cannot tell them apart, so the copy must not pick
   * one. It must also not read as "no creator holdings", since the tokens could sit
   * in a second address this cannot see.
   */
  const d = describeCreatorHolding({ held: 0n, share: 0 });
  assert.match(d.text, /at this address/);
  for (const forbidden of ['sold', 'dumped', 'no creator holdings', 'fully distributed']) {
    assert.ok(!d.text.toLowerCase().includes(forbidden), `the copy claims "${forbidden}"`);
  }
});

test('every holding is qualified by the address it was measured at', () => {
  // A creator can hold more elsewhere. This is a floor on their position, never a
  // ceiling, and each line has to carry that or it reads as the whole picture.
  for (const share of [0, 0.01, 0.1, 0.5]) {
    const d = describeCreatorHolding({ held: BigInt(Math.round(share * 1e6)) * ONE, share });
    assert.match(d.text, /at this address/, `a ${share * 100}% holding was stated unqualified`);
  }
});

test('a dominant position is called what it is', () => {
  // The point of showing this number. A creator holding a fifth of the supply can
  // move the price on their own, and a muted grey percentage does not say so.
  const big = describeCreatorHolding({ held: 400n * ONE, share: 0.4 });
  assert.equal(big.tone, 'danger');
  assert.match(big.text, /move the price/);

  assert.equal(describeCreatorHolding({ held: 80n * ONE, share: 0.08 }).tone, 'warn');
  assert.equal(describeCreatorHolding({ held: 10n * ONE, share: 0.01 }).tone, 'muted');
});

test('first-block concentration is measured from the first trade, not from creation', () => {
  /*
   * A curve created on Monday and first traded on Friday has no meaningful "first
   * block" relative to its creation: measuring from creation would report 0% for a
   * launch where one address took half the supply in the opening block of actual
   * trading, which is exactly the case this exists to expose.
   */
  const supply = 1_000n * ONE;
  const trades = [
    { kind: 'buy', tokens: 300n * ONE, height: 5_000 },
    { kind: 'buy', tokens: 200n * ONE, height: 5_001 },
    { kind: 'buy', tokens: 100n * ONE, height: 9_999 },
  ];
  const r = firstBlockShare(trades, supply, 3);
  assert.ok(r.share !== null);
  assert.ok(Math.abs((r.share as number) - 0.5) < 1e-9, `got ${r.share}`);
});

test('sells do not count toward supply taken early', () => {
  // The figure is how much was TAKEN in the opening, so a sell in the window is not a
  // negative: it is a different event and subtracting it would understate the grab.
  const supply = 1_000n * ONE;
  const r = firstBlockShare(
    [
      { kind: 'buy', tokens: 400n * ONE, height: 10 },
      { kind: 'sell', tokens: 400n * ONE, height: 11 },
    ],
    supply,
    3,
  );
  assert.ok(Math.abs((r.share as number) - 0.4) < 1e-9, `a sell changed the figure: ${r.share}`);
});

test('no trades means no figure, not zero percent', () => {
  // A launch nobody has bought has no concentration to report, and "0% taken early"
  // would read as evidence of a fair opening that has not happened yet.
  assert.equal(firstBlockShare([], 1_000n * ONE, 3).share, null);
  assert.equal(firstBlockShare([{ kind: 'graduate', tokens: null, height: 1 }], 1_000n * ONE).share, null);
});
