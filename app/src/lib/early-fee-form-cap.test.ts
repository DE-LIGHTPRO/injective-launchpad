/**
 * The form will not offer an opening fee the configured factory cannot price.
 *
 * V-01, AND ITS MITIGATION BEING RETIRED. `Curve._cfg(currentFeeBps())` folds the
 * opening premium into `feeBps` and hands it to `CurveMath.validate`, which on the
 * old contracts refused anything over `MAX_FEE_BPS` of 1,000. The factory accepted an
 * opening fee up to 2,000, so a launch created with one between 10.01% and 20%
 * reverted every buy and every sell with `FeeTooHigh` until the premium decayed:
 * unusable for exactly the window the opening fee exists for, accepted at creation
 * without complaint, invisible until somebody traded.
 *
 * While `0x3D811414…` was the configured factory this form capped at 10%, because it
 * must not create what that chain could not trade. `0xe24adc45…` carries the fix -
 * two ceilings for two questions - and `evm/test/DeployedFactory.t.sol` proves it
 * against the DEPLOYED bytecode by creating a launch with a 15% opening fee and
 * trading it. So the cap is back at the contract ceiling.
 *
 * THE CONSTANT STAYS SEPARATE, equal rather than merged. "What the contracts permit"
 * and "what this form offers" are different questions that happen to agree today, and
 * the next time a deployed factory cannot do something the source can, this is where
 * that gets said.
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

test('the form offers exactly what the contracts permit', () => {
  assert.equal(FORM_MAX_EARLY_FEE_BPS, MAX_EARLY_FEE_BPS);
  /*
   * And that is ABOVE the standing-rate cap, which is the whole point of V-01's fix:
   * an opening premium is allowed to exceed what a launch may charge as its ordinary
   * rate, and the trade-time arithmetic has to accept it.
   */
  assert.ok(
    FORM_MAX_EARLY_FEE_BPS > MAX_FEE_BPS,
    'the form cap has fallen back to the standing-rate cap, which was the V-01 mitigation',
  );
});

test('the range V-01 used to brick is now offered', () => {
  /*
   * Every one of these was refused by the form while the old factory was configured,
   * and every one of them bricked a launch on it. `DeployedFactory.t.sol` trades the
   * middle of this range against the bytecode actually deployed.
   */
  for (const bps of [1_001, 1_500, MAX_EARLY_FEE_BPS]) {
    assert.deepEqual(problems(bps), [], `an opening fee of ${bps} bps is still refused`);
  }
});

test('above the contract ceiling is still refused, and says why', () => {
  const over = problems(MAX_EARLY_FEE_BPS + 1);
  assert.equal(over.length, 1, 'an opening fee above what the contract accepts was allowed');
  assert.equal(over[0].field, 'earlyFee');
  assert.match(over[0].message, new RegExp(`${MAX_EARLY_FEE_BPS / 100}%`));
});

test('an opening fee at or under the base rate is still refused', () => {
  // It would never apply, so storing it advertises a rule the launch does not have.
  assert.equal(problems(100).length, 1, 'an opening fee equal to the base rate was accepted');
  assert.equal(problems(50).length, 1, 'an opening fee below the base rate was accepted');
  assert.deepEqual(problems(101), [], 'one basis point above the base rate was refused');
});
