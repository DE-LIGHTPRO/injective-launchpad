/**
 * Board figures, and the two columns this chain cannot fill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { marketCap, ageLabel, feeLabel, boardTotals, compact } from './boardMetrics.ts';
import type { CurveConfig, CurveState } from './curve.ts';

const ONE = 10n ** 18n;
const cfg: CurveConfig = {
  virtualInj: 30n * ONE,
  virtualTokens: 1_073_000_000n * ONE,
  curveSupply: 800_000_000n * ONE,
  graduationTarget: 85n * ONE,
  feeBps: 100n,
  feeSellBps: 100n,
};
const fresh: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };

test('market cap scales once, not twice', () => {
  /*
   * The arithmetic that is wrong by eighteen orders of magnitude if the token unit is
   * dropped, and which renders as a plausible-looking enormous number rather than as
   * an error. A fresh curve prices a token at virtualInj/virtualTokens, so a billion
   * tokens is tens of INJ, not tens of quintillions.
   */
  const total = 1_000_000_000n * ONE;
  const mc = marketCap(cfg, fresh, total);
  const whole = Number(mc) / Number(ONE);
  assert.ok(whole > 1 && whole < 1_000_000, `market cap is ${whole}, which is not a plausible scale`);
});

test('market cap rises as the curve is bought', () => {
  // The only direction it can go on a curve, and the thing a board is sorted by.
  const total = 1_000_000_000n * ONE;
  const later: CurveState = { injCollected: 40n * ONE, tokensSold: 400_000_000n * ONE, graduated: false };
  assert.ok(marketCap(cfg, later, total) > marketCap(cfg, fresh, total));
});

test('an unknown creation time is not "just now"', () => {
  /*
   * A zero timestamp formats to the epoch, and a naive "time since" would label the
   * oldest launches on the board as the newest: the most eye-catching claim a board
   * can make, applied to exactly the wrong rows. A launch stored before `opened_at`
   * existed defaults to zero, so this is reachable rather than theoretical.
   */
  assert.equal(ageLabel(null, 1_000_000), null);
  assert.equal(ageLabel(0, 1_000_000), null);
});

test('age reads in the largest unit that is still true', () => {
  const now = 10_000_000;
  assert.equal(ageLabel(now - 30, now), 'just now');
  assert.equal(ageLabel(now - 300, now), '5m ago');
  assert.equal(ageLabel(now - 7_200, now), '2h ago');
  assert.equal(ageLabel(now - 86_400 * 3, now), '3d ago');
  // Clock skew between a browser and a chain is ordinary; a launch from the future
  // must not render as a negative or as a very large age.
  assert.equal(ageLabel(now + 5, now), 'just now');
});

test('the fee badge shows one number, because there is one fee', () => {
  /*
   * nearly.trade shows "TAX 1/1" because their tokens tax buys and sells separately.
   * This curve charges one fee on both sides, so a pair would imply two independently
   * settable numbers that do not exist.
   */
  assert.equal(feeLabel(100n), '1% fee');
  assert.equal(feeLabel(250n), '2.50% fee');
  assert.equal(feeLabel(0n), '0% fee');
  assert.ok(!feeLabel(100n).includes('/'), 'the badge implies a buy/sell pair');
});

test('totals come from the rows on screen, so they cannot contradict them', () => {
  const rows = [
    { raised: 10n * ONE, feesAccrued: ONE / 10n, graduated: false, creatorPaid: 2n * ONE },
    { raised: 85n * ONE, feesAccrued: ONE, graduated: true, creatorPaid: 0n },
    { raised: 5n * ONE, feesAccrued: ONE / 100n, graduated: false, creatorPaid: ONE / 2n },
  ];
  const t = boardTotals(rows);
  assert.equal(t.launches, 3);
  assert.equal(t.graduated, 1);
  assert.equal(t.raised, 100n * ONE);
  assert.equal(t.feesAccrued, ONE + ONE / 10n + ONE / 100n);
  /*
   * Summed independently of `feesAccrued`, and the fixture makes them disagree on
   * purpose: row two has a full INJ unclaimed and has paid out nothing, row three has
   * paid out more than it is holding. Equal fixtures would let one field be computed
   * from the other without the test noticing.
   */
  assert.equal(t.paidToCreators, 2n * ONE + ONE / 2n);
  // An empty board is zeros, not a crash and not a blank.
  assert.deepEqual(boardTotals([]), {
    launches: 0,
    raised: 0n,
    feesAccrued: 0n,
    paidToCreators: 0n,
    graduated: 0,
  });
});

test('a small figure keeps its precision instead of reading as zero', () => {
  /*
   * On a new board most launches hold a fraction of one INJ, and two decimal places
   * renders every one of them as 0.00: a board where nothing has happened, when
   * something has.
   */
  assert.equal(compact(ONE / 1000n), '0.0010');
  assert.equal(compact(ONE * 1500n), '1.50K');
  assert.equal(compact(ONE * 2_500_000n), '2.50M');
  assert.equal(compact(0n), '0.00');
  assert.ok(!compact(ONE / 1000n).startsWith('0.00K'), 'a tiny figure was given a unit suffix');
});
