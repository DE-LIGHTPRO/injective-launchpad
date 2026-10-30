/**
 * The form will not create a launch the deployed curve cannot price.
 *
 * V-01. `Curve._cfg(currentFeeBps())` folds the opening premium into `feeBps` and
 * hands it to `CurveMath.validate`, which refused anything over `MAX_FEE_BPS` of
 * 1,000. The factory accepts an opening fee up to 2,000, so a launch created with one
 * between 10.01% and 20% reverted every buy and every sell with `FeeTooHigh` until the
 * premium decayed under 10%: unusable for exactly the window the opening fee exists
 * for, accepted at creation without complaint, invisible until somebody traded.
 * Reproduced and pinned in `evm/test/EarlyFee.t.sol`.
 *
 * THE CONTRACT FIX IS IN SOURCE AND THE DEPLOYED FACTORY IS IMMUTABLE, which is the
 * whole reason this cap exists separately. `0x3D811414…` still carries the old
 * ceiling, so until a factory with the fix is deployed AND configured, this form must
 * refuse what that chain cannot price.
 *
 * Raise `FORM_MAX_EARLY_FEE_BPS` to `MAX_EARLY_FEE_BPS` when the new factory is live,
 * and not before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FORM_MAX_EARLY_FEE_BPS, MAX_EARLY_FEE_BPS, validateRules } from './launchRules.ts';
import { MAX_FEE_BPS } from './launchLimits.ts';

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
const NOW = 1_800_000_000;

function problems(startBps: number) {
  return validateRules(
    { maxPerWallet: null, tradeStart: null, earlyFee: { startBps, seconds: 600 }, openedAt: null },
    CURVE_SUPPLY,
    NOW,
    100,
  );
}

test('the form cap is the rate the deployed curve can actually quote', () => {
  /*
   * Equal to the base-rate cap, because that is the ceiling the deployed
   * `CurveMath.validate` applies to the EFFECTIVE rate. Stated as the relationship
   * rather than as 1_000, so the reason survives the number.
   */
  assert.equal(FORM_MAX_EARLY_FEE_BPS, MAX_FEE_BPS);
  assert.ok(
    FORM_MAX_EARLY_FEE_BPS < MAX_EARLY_FEE_BPS,
    'the form cap has caught up with the contract ceiling; only do that once the fixed factory is live',
  );
});

test('an opening fee the deployed curve would brick is refused by the form', () => {
  // The boundary, both sides of it.
  assert.deepEqual(problems(FORM_MAX_EARLY_FEE_BPS), [], 'the cap itself is refused');

  const over = problems(FORM_MAX_EARLY_FEE_BPS + 1);
  assert.equal(over.length, 1, 'one over the cap was accepted');
  assert.equal(over[0].field, 'earlyFee');

  /*
   * And the message says WHY, because "the most is 10%" reads as an arbitrary house
   * rule. What a creator needs to know is that the launch would open untradeable.
   */
  assert.match(over[0].message, /untradeable|cannot price/i);

  // The whole range that used to be accepted and would have bricked the launch.
  for (const bps of [1_001, 1_500, MAX_EARLY_FEE_BPS]) {
    assert.equal(problems(bps).length, 1, `an opening fee of ${bps} bps was accepted`);
  }
});

test('an opening fee at or below the cap is still allowed', () => {
  for (const bps of [101, 500, 999, 1_000]) {
    assert.deepEqual(problems(bps), [], `a legal opening fee of ${bps} bps was refused`);
  }
  // Still refused for the reason it always was: at or under the base rate it never applies.
  assert.equal(problems(100).length, 1, 'an opening fee equal to the base rate was accepted');
});
