/**
 * THE OPENING PREMIUM IS CHARGED ON WHAT IS SPENT, AND THE PANEL CHARGED IT ON WHAT
 * WAS PAID. Those are the same number on every buy the curve can absorb whole, and
 * different on the one that overshoots the remaining capacity.
 *
 * `exec_buy` quotes once to find what the curve cannot take, subtracts that, charges
 * the premium on the rest, and re-quotes. Its own comment says skimming from `inj_in`
 * would charge the premium on quote handed straight back, and that the case where
 * that happens is "close to impossible", which is "exactly the assumption that
 * becomes a defect". `TradePanel` then wrote `(raw * premiumBps) / 10_000n`.
 *
 * `min_tokens_out` is derived from the panel's figure and enforced on chain, so the
 * overstatement did not show up as a bad price. It showed up as a REFUSED TRADE,
 * reported as slippage, for a trade where nothing had moved. Measured on the
 * deployed shape (virtual quote 676, target 676*17/6) from a fresh curve whose
 * capacity is 2000.962 quote, at the default 1% tolerance:
 *
 *      10% premium, in 2201.06 (10% over)  contract 778,006,042  panel 797,949,296  REVERT
 *      10% premium, in 4001.92 (2x over)   contract 778,006,042  panel 800,000,000  REVERT
 *      19% premium, in 4001.92 (2x over)   contract 754,944,625  panel 800,000,000  REVERT
 *
 * The last is +5.96%, so a 3% tolerance did not save it either. The refund row was
 * wrong by the same cause: the panel showed 0 where the contract returns 200.0962.
 * Reachable with the Max button on a large balance during an opening window.
 *
 * WHY NOTHING CAUGHT IT. The arithmetic lived inside the component, where no test
 * can reach it - the same reason `stateAtRaised` was lifted out of `CurveExplorer`,
 * recorded in its own docblock. The parity vectors could not cover it either: they
 * are generated from `launchpad-math`, and the premium is contract-level, so there
 * was no Rust number for the port to disagree with. Both halves were locally
 * consistent and neither was wrong on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  quoteBuy,
  quoteBuyWithPremium,
  effectiveFeeBps,
  fmt,
  type CurveConfig,
  type CurveState,
} from './curve.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const CONTRACT = join(SRC, '..', '..', 'contracts', 'curve', 'src', 'contract.rs');

const ONE = 10n ** 18n;
/** The shape the factory actually builds: `factory/src/lib.rs` lines 146 to 169. */
const CFG: CurveConfig = {
  virtualInj: 676n * ONE,
  virtualTokens: 1_073_000_000n * ONE,
  curveSupply: 800_000_000n * ONE,
  graduationTarget: (676n * ONE * 17n) / 6n,
  feeBps: 100n,
  // The premium is a buy-side charge, so this file never reads the sell fee; it is
  // here because the shape requires it, at the form's own symmetric default.
  feeSellBps: 100n,
};
const FRESH: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };

/**
 * The contract's algorithm, written out here so the mirror has something to be
 * compared against rather than only something to be read.
 *
 * Kept honest by `the contract still charges the premium on what is spent` below,
 * which pins the three decisive lines of Rust. Without that this is just a second
 * opinion with no claim on the chain, which is how a mirror comes to agree with
 * itself and with nothing else.
 */
function asTheContractDoes(cfg: CurveConfig, st: CurveState, injIn: bigint, premiumBps: bigint) {
  if (premiumBps === 0n) return { ...quoteBuy(cfg, st, injIn), earlyFeePremium: 0n };
  const probe = quoteBuy(cfg, st, injIn);
  const spent = injIn - probe.refund;
  const premium = (spent * premiumBps) / 10_000n;
  const q = quoteBuy(cfg, st, spent - premium);
  return { ...q, refund: q.refund + probe.refund, earlyFeePremium: premium };
}

/** What the panel used to do: the premium skimmed off the whole payment. */
function theOldWrongBasis(cfg: CurveConfig, st: CurveState, injIn: bigint, premiumBps: bigint) {
  const premium = premiumBps > 0n ? (injIn * premiumBps) / 10_000n : 0n;
  return { ...quoteBuy(cfg, st, injIn - premium), earlyFeePremium: premium };
}

/** Quote the curve can still absorb from `st`, found by overshooting it deliberately. */
function capacity(st: CurveState): bigint {
  const huge = 10_000_000n * ONE;
  return huge - quoteBuy(CFG, st, huge).refund;
}

const CAP = capacity(FRESH);
const PREMIUMS = [0n, 500n, 1_000n, 1_900n, 2_000n] as const;
const SIZES: Array<[string, bigint]> = [
  ['1 quote', ONE],
  ['100', 100n * ONE],
  ['one under capacity', CAP - 1n],
  ['exactly capacity', CAP],
  ['one over capacity', CAP + 1n],
  ['10% over', (CAP * 110n) / 100n],
  ['2x over', CAP * 2n],
  ['50x over', CAP * 50n],
];

test('the mirror agrees with the contract on every size and premium', () => {
  for (const premiumBps of PREMIUMS) {
    for (const [label, injIn] of SIZES) {
      const mine = quoteBuyWithPremium(CFG, FRESH, injIn, premiumBps);
      const theirs = asTheContractDoes(CFG, FRESH, injIn, premiumBps);
      const where = `${Number(premiumBps) / 100}% premium, ${label}`;
      assert.equal(mine.tokensOut, theirs.tokensOut, `tokensOut diverges at ${where}`);
      assert.equal(mine.refund, theirs.refund, `refund diverges at ${where}`);
      assert.equal(mine.fee, theirs.fee, `curve fee diverges at ${where}`);
      assert.equal(mine.earlyFeePremium, theirs.earlyFeePremium, `premium diverges at ${where}`);
      assert.equal(mine.graduates, theirs.graduates, `graduation diverges at ${where}`);
    }
  }
});

/*
 * ANTI-VACUITY, AND THE POINT OF THE WHOLE FILE. A sweep that the defect passes is
 * not a guard. This asserts the old basis is actually caught by the sweep above, and
 * caught on the overshooting sizes specifically, so the fixture is known to
 * discriminate rather than assumed to.
 */
test('the sweep catches the basis that shipped', () => {
  let caught = 0;
  let agreed = 0;
  for (const premiumBps of PREMIUMS) {
    for (const [, injIn] of SIZES) {
      const old = theOldWrongBasis(CFG, FRESH, injIn, premiumBps);
      const theirs = asTheContractDoes(CFG, FRESH, injIn, premiumBps);
      if (old.tokensOut === theirs.tokensOut && old.refund === theirs.refund) agreed += 1;
      else caught += 1;
    }
  }
  assert.ok(caught >= 10, `the old basis was only caught at ${caught} of ${PREMIUMS.length * SIZES.length} points`);
  // And it must still agree where it always did, or the sweep is failing for some
  // other reason and would have failed a correct implementation too.
  assert.ok(agreed >= 12, `the old basis agreed at only ${agreed} points, so something else is wrong`);
});

test('a buy the curve cannot absorb whole is refused at the default tolerance', () => {
  /*
   * The defect as a user met it. 1% is the panel's default, and the figure the panel
   * quoted is what `min_tokens_out` was built from, so this is a revert.
   */
  const injIn = (CAP * 110n) / 100n;
  const premiumBps = 1_000n;
  const quoted = theOldWrongBasis(CFG, FRESH, injIn, premiumBps).tokensOut;
  const delivered = asTheContractDoes(CFG, FRESH, injIn, premiumBps).tokensOut;
  const minOut = (quoted * 9_900n) / 10_000n;
  assert.ok(delivered < minOut, 'the old basis no longer reverts, so this no longer measures it');

  // And the version that ships does not.
  const nowQuoted = quoteBuyWithPremium(CFG, FRESH, injIn, premiumBps).tokensOut;
  assert.ok(
    delivered >= (nowQuoted * 9_900n) / 10_000n,
    'the shipped quote still asks for more than the contract delivers',
  );
  assert.equal(nowQuoted, delivered, 'the shipped quote is not the delivered amount');
});

test('the refund the panel shows is the refund the contract sends', () => {
  // Both parts: what the second quote cannot take, plus what the first already found
  // unabsorbable. Dropping the carried half was a solvency hole on the contract side
  // and is a wrong number here.
  const injIn = CAP * 2n;
  const q = quoteBuyWithPremium(CFG, FRESH, injIn, 1_000n);
  assert.ok(q.refund > 0n, 'a buy at twice the capacity refunds nothing');
  assert.equal(
    injIn - q.refund - q.earlyFeePremium - q.fee,
    q.injInAfterFee,
    'the payment does not account for: refund, premium, curve fee, and what reached the curve',
  );
});

test('the premium is floored, never rounded up', () => {
  // `multiply_ratio` floors. A premium rounded up is a charge the contract does not
  // make, and on the smallest inputs it is the whole difference.
  for (const injIn of [ONE + 1n, ONE + 9_999n, 3n * ONE + 7n]) {
    const q = quoteBuyWithPremium(CFG, FRESH, injIn, 1_900n);
    assert.equal(q.earlyFeePremium, (injIn * 1_900n) / 10_000n);
  }
});

test('the contract still charges the premium on what is spent', () => {
  /*
   * The mirror above is only a mirror of these lines. If the contract moves to a
   * different basis this fails here rather than in a user's wallet.
   */
  const rs = readFileSync(CONTRACT, 'utf8');
  assert.match(
    rs,
    /let spent = inj_in\.checked_sub\(probe\.refund\)\?;/,
    'the contract no longer subtracts the refund before charging the premium',
  );
  assert.match(
    rs,
    /let premium = spent\.multiply_ratio\(premium_bps as u128, BPS\);/,
    'the contract no longer charges the premium on what is spent',
  );
  assert.match(
    rs,
    /let total_refund = q\.refund\.checked_add\(carried_refund\)\?;/,
    'the contract no longer carries the first quote\u2019s refund',
  );
});

/**
 * THE SECOND HALF OF THE SAME DEFECT, found by the external audit of 19 Oct 2026 and
 * recorded as F-11: once the panel quoted the premium correctly, it still LABELLED
 * the result with the sum of the two rates. "Fee 4.45 percent" above 0.004415 INJ on
 * a 0.1 INJ buy, which is 4.4155 percent.
 *
 * Neither number was wrong about its own basis, which is why neither looked wrong.
 * The premium comes off the top and the curve's fee is charged on what is left, so
 * the rates compose rather than add.
 */
test('the fee rate is measured out of the amount, not added up from two rates', () => {
  const spend = ONE / 10n; // 0.1, the audit's figure.
  // A 4.45% charged rate over a 1% curve fee, which is a 3.45% premium.
  const q = quoteBuyWithPremium(CFG, FRESH, spend, 345n);
  const charged = q.fee + q.earlyFeePremium;

  // The audit's measurement, to the digit it reported.
  assert.equal(fmt(charged, 18, 6), '0.004415', 'the charged amount is no longer the audit\u2019s');

  const bps = effectiveFeeBps(charged, q.injInAfterFee);
  assert.ok(bps !== null, 'a fee with a basis behind it has a rate');
  assert.equal((bps / 100).toFixed(2), '4.42', 'the rate shown is not the rate charged');

  /*
   * And the figure the panel used to print, asserted as WRONG rather than merely
   * absent, so restoring it fails here instead of passing quietly.
   */
  assert.notEqual((bps / 100).toFixed(2), '4.45', 'the sum of the two rates is back');
  assert.ok(bps < 445, 'composing two rates cannot cost more than adding them');
});

test('a buy with no premium still reads as the curve\u2019s own fee', () => {
  /*
   * The derived rate has to agree with the constant wherever there is nothing to
   * compose, or the fix would have traded one wrong label for a noisier one. The
   * contract floors the fee, so the raw bps lands just under 100 and the two decimal
   * places it is shown to are what make them equal.
   */
  const q = quoteBuyWithPremium(CFG, FRESH, 3n * ONE, 0n);
  const bps = effectiveFeeBps(q.fee + q.earlyFeePremium, q.injInAfterFee);
  assert.ok(bps !== null);
  assert.equal((bps / 100).toFixed(2), '1.00');
  assert.ok(bps <= 100, 'a floored fee cannot exceed its own rate');
});

test('a fee with no basis behind it has no rate, never a zero', () => {
  // Rule: a figure is measured or it is unknown. 0% would be a claim about a trade
  // that was never priced, and the row renders the bare word "Fee" instead.
  assert.equal(effectiveFeeBps(0n, 0n), null);
  assert.equal(effectiveFeeBps(-1n, ONE), null);
  assert.equal(effectiveFeeBps(ONE, -1n), null);
  // A free venue is a measurement, so it is 0 bps rather than null.
  assert.equal(effectiveFeeBps(0n, ONE), 0);
});

test('the panel reads the rate off the amount it prints', () => {
  /*
   * REGISTRATION IS NOT WIRING. `effectiveFeeBps` could exist, pass everything above,
   * and the row could keep printing `chargedBps`: the helper's own tests cannot see
   * the label. Caught by mutation, so asserted at the source, the same way the
   * premium basis above it is.
   */
  const panel = maskComments(readFileSync(join(SRC, 'components', 'TradePanel.tsx'), 'utf8'));
  assert.match(panel, /effectiveFeeBps\s*\(/, 'the panel no longer derives the rate it shows');
  // The label itself, not merely the derivation above it: the helper could be called
  // and its result ignored, which is the shape a mutation found.
  assert.match(
    panel,
    /feeChargedBps\s*\/\s*100\)\.toFixed\(2\)/,
    'the fee row is labelled from something other than the rate measured off its amount',
  );
  assert.ok(
    !/\bchargedBps\s*\/\s*100/.test(panel),
    'the summed rate is rendered again, and it is the figure F-11 reported',
  );
  /*
   * And the note underneath must not restate the sum the row was corrected away
   * from. It said "3.45% above the curve's 1.00%", which a reader adds to 4.45%:
   * the right figure, in the wrong place, is the same disclosure defect.
   */
  assert.ok(
    !/%\s*above the curve/.test(panel),
    'the opening-fee note invites the addition again',
  );
  assert.match(panel, /comes off first, then the/, 'the note no longer states the sequence');
});

test('the panel does not do its own premium arithmetic', () => {
  /*
   * The structural half. The defect was not the expression being wrong so much as it
   * being somewhere no test could see it, which is why fixing the expression in place
   * would leave the next one equally invisible.
   */
  const panel = maskComments(readFileSync(join(SRC, 'components', 'TradePanel.tsx'), 'utf8'));
  assert.match(panel, /quoteBuyWithPremium\s*\(/, 'the panel no longer quotes through the mirror');
  assert.ok(
    !/premiumBps\s*\)?\s*\)\s*\/\s*10_000n/.test(panel) && !/raw\s*\*\s*BigInt\(premiumBps\)/.test(panel),
    'the panel is scaling by premiumBps itself again',
  );
});
