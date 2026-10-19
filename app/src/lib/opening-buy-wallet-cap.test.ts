/**
 * THE CREATOR'S OWN CAP REFUSES THE CREATOR, AND THE FORM DID NOT SAY SO.
 *
 * `max_per_wallet` and `initial_buy` are two optional fields in one form and setting
 * both together is the natural thing to do: cap each buyer, and take an opening
 * position. The factory buys with the creator as recipient on a curve nobody has
 * touched, so it checks `would_exceed_cap(0, tokens_out)` and returns
 * `InitialBuyOverCap`, reverting the whole launch - after the creator has read the
 * summary, ticked the irreversibility box, opened their wallet and signed.
 *
 * The form checked the OTHER limit. `initialBuyCeiling` (10% of the curve) was wired
 * into `ok` and blocked the plan; the creator's own cap was not checked anywhere, and
 * `validateRules` cannot see it because it is never passed the opening buy.
 *
 * WHY IT IS REACHABLE AT ORDINARY NUMBERS. Measured against the default shape on
 * 18 Oct 2026, with `quoteBuy` on a fresh curve:
 *
 *     1 INJ  ->  1.569M tokens
 *     5 INJ  ->  7.800M tokens
 *    55 INJ  -> 80.000M tokens   <- where the 10% ceiling finally binds
 *
 * So a cap in the single-digit millions, which is what a creator writing a cap
 * actually types, is passed by an opening buy of a few INJ, and the ceiling the form
 * did check does not come near it. This is the same class as `launchCost`: the page
 * held both numbers and compared neither.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openingBuyOverCap, NO_RULES, type LaunchRules } from './launchRules.ts';
import { quoteBuy } from './curve.ts';
import {
  fixedCurveFor,
  DEFAULT_FEE_BPS,
  initialBuyCeiling,
  MAX_INITIAL_BUY_BPS,
} from './launchLimits.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const ONE = 10n ** 18n;

const CURVE = {
  ...fixedCurveFor(18),
  feeBps: BigInt(DEFAULT_FEE_BPS),
  feeSellBps: BigInt(DEFAULT_FEE_BPS),
};
const FRESH = { injCollected: 0n, tokensSold: 0n, graduated: false };

/** What an opening buy of `inj` whole INJ takes off a fresh curve. */
function tokensFor(inj: bigint): bigint {
  return quoteBuy(CURVE, FRESH, inj * ONE).tokensOut;
}

function withCap(cap: bigint | null): LaunchRules {
  return { ...NO_RULES, maxPerWallet: cap };
}

test('an opening buy over the creator\u2019s own cap is refused, matching the contract', () => {
  /*
   * Pinned at the BOUNDARY as well as either side of it, because the contract's
   * comparison is a strict `>`: a buy landing exactly on the cap is allowed there, so
   * refusing it here would block a launch the chain would accept.
   */
  assert.equal(openingBuyOverCap(withCap(100n), 101n), true);
  assert.equal(openingBuyOverCap(withCap(100n), 100n), false, 'the boundary is allowed on chain');
  assert.equal(openingBuyOverCap(withCap(100n), 99n), false);

  // No cap is no refusal, which is most launches.
  assert.equal(openingBuyOverCap(withCap(null), 10n ** 30n), false, 'an absent cap refused a buy');
  assert.equal(openingBuyOverCap(NO_RULES, 10n ** 30n), false);
});

test('the case the form let through: an ordinary cap and an ordinary opening buy', () => {
  /*
   * ANTI-VACUITY, and the reason this is a defect rather than a theoretical gap. The
   * numbers are the ones a creator types, not extremes, and the limit the form DID
   * check passes all of them.
   */
  const cap = 5_000_000n * ONE;
  const ceiling = initialBuyCeiling(CURVE.curveSupply);

  const tokens = tokensFor(5n);
  assert.ok(tokens > cap, `5 INJ took ${tokens}, which did not exceed a 5M cap`);
  assert.ok(
    tokens < ceiling,
    'the 10% ceiling binds here too, so this case cannot show the gap it was meant to show',
  );
  assert.equal(openingBuyOverCap(withCap(cap), tokens), true);

  // And the ceiling really is far away, so it was never going to catch this.
  assert.ok(
    ceiling > cap * 10n,
    `the ceiling is ${ceiling} against a ${cap} cap; the two limits are not far enough apart for this test to mean anything`,
  );

  // 1 INJ already passes a cap of one million.
  assert.equal(openingBuyOverCap(withCap(1_000_000n * ONE), tokensFor(1n)), true);
});

test('the check is wired into what blocks the plan, not merely exported', () => {
  /*
   * Rule 52 on this project: registration is not wiring. `getExecutionBlocker` had nine
   * passing tests and no call sites, and this file would read exactly the same if
   * `openingBuyOverCap` were never called. So the assertions below are about the
   * component, which is the only place the refusal can actually stop a signature.
   */
  const src = maskComments(readFileSync(join(SRC, 'components', 'CreateLaunch.tsx'), 'utf8'));

  assert.match(src, /openingBuyOverCap\(builtRules, q\.tokensOut\)/, 'the preview no longer computes it');
  assert.match(src, /overWalletCap: /, 'the preview no longer carries the result');

  /*
   * The half that matters: `ok` gates the Create button. Pinned as its own assertion
   * because computing a refusal and rendering it as a red sentence, while leaving the
   * button live, is precisely what this cap's own contract comment records the create
   * form doing before `MAX_INITIAL_BUY_BPS` existed - "the one guarantee a launchpad
   * exists to make was a sentence in a React component".
   */
  assert.match(
    src,
    /const ok =[\s\S]*?!devBuyPreview\?\.overWalletCap/,
    'the opening-buy cap check does not block the plan',
  );

  // And the memo can see the cap at all, which it could not before.
  assert.match(
    src,
    /\}, \[devBuy, built, builtRules\]\);/,
    'the preview no longer depends on the rules, so the cap it reads would go stale',
  );

  // The copy names the creator's cap separately from our ceiling: different limits,
  // different remedies, and one standing in for the other misdirects the fix.
  assert.match(src, /your own wallet cap refuses it/i, 'the creator is not told which limit refused');
  assert.match(src, /Lower the opening buy or raise the cap/, 'the copy does not say what to change');
});

test('the mirrored cap constant is still the contract\u2019s, and the evidence for it is measured', () => {
  /*
   * The cap is a share of CURVE supply and the form displays a share of TOTAL supply.
   * That distinction has now been got wrong twice in the comment that argues for the
   * constant: once against a curve two rescalings old, and once by re-deriving against
   * the wrong denominator, which produced "10% lands at roughly 69.5 INJ" for a limit
   * that binds at 55.0. So the figure is asserted here rather than trusted.
   */
  const rust = readFileSync(join(SRC, '..', '..', 'contracts', 'factory', 'src', 'lib.rs'), 'utf8');

  const ceiling = initialBuyCeiling(CURVE.curveSupply);
  assert.equal(
    ceiling,
    (CURVE.curveSupply * BigInt(MAX_INITIAL_BUY_BPS)) / 10_000n,
    'the ceiling is no longer a share of the curve supply',
  );

  // The INJ figure the Rust comment now claims, bisected against the same maths.
  let lo = 0n;
  let hi = 2_000n * ONE;
  while (hi - lo > ONE / 1_000n) {
    const mid = (lo + hi) / 2n;
    if (quoteBuy(CURVE, FRESH, mid).tokensOut > ceiling) hi = mid;
    else lo = mid;
  }
  const inj = Number(lo) / 1e18;
  assert.ok(
    Math.abs(inj - 55.0) < 0.1,
    `the cap now binds at ${inj.toFixed(3)} INJ; the comment in contracts/factory/src/lib.rs says 55.0 and needs re-deriving`,
  );

  /*
   * And the comment is pinned to the figure just bisected, which is what makes this a
   * check rather than two numbers a reader is invited to compare. The dead 69.5 is
   * deliberately NOT banned by pattern: it survives in the paragraph recording the
   * mistake, in quotation marks, and a guard that forbade the string would forbid the
   * record of why it was wrong. Re-deriving against the wrong denominator again would
   * change THIS figure, so this is the assertion that catches it.
   */
  assert.match(
    rust,
    /10% of the curve lands at \*\*55\.0 INJ\*\*/,
    'the comment no longer states where 10% of the curve binds, so nothing pins the re-derivation',
  );
});
