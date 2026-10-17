/**
 * Every client constant that claims to mirror the factory, pinned to the factory.
 *
 * WHAT WAS WRONG. `launchLimits.ts` opens by saying a mirror is a second copy of a fact,
 * "which is how a UI and a contract come to disagree quietly, so `launch-limits.test.ts`
 * reads the Rust source and fails if either value drifts". There is no
 * `launch-limits.test.ts`. There never was. Six of the ten mirrored figures were pinned
 * nowhere: the curve's whole shape (`CURVE_VIRTUAL_TOKENS`, `CURVE_SUPPLY`,
 * `CURVE_VIRTUAL_QUOTE_WHOLE`, `GRADUATION_NUM`/`GRADUATION_DEN`) and both string
 * ceilings in `tokenProfile.ts`.
 *
 * EVERY VALUE AGREES TODAY. This is an unguarded mirror, not a live defect, and it is
 * worth saying which: a guard written against a drifted value would have to decide which
 * side is right, and that decision is not a test's to make. The contract is the authority
 * and the client follows.
 *
 * WHY IT MATTERS FOR MAINNET. The create form states the opening reserve, the graduation
 * target and the curve ceiling as the fixed, unchangeable terms of the launch, and a
 * creator reads them before signing. Those rows are built from these constants; the curve
 * that gets signed is built from the Rust. A drift does not fail, it misrepresents - the
 * exact shape of the `676 E2EUSD` defect recorded in `openingReserveWholeFor`, where the
 * form printed terms the chain contradicted. The factory is deployed from a compiled
 * wasm, so after mainnet the Rust constant is the one that cannot be edited.
 *
 * Three constants are pinned elsewhere and deliberately not repeated here:
 * `CREATOR_FEE_SHARE_BPS`, `FIXED_TOTAL_SUPPLY` and `MAX_INITIAL_BUY_BPS` in
 * `execution-wiring.test.ts`, `MAX_FEE_BPS` in `fee-ceiling-claims.test.ts`. A second copy
 * of a pin is a second thing to drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIXED_CURVE,
  OPENING_RESERVE_QUOTE,
  fixedCurveFor,
  graduationWholeFor,
} from './launchLimits.ts';
import { MAX_URI_LEN, MAX_DESCRIPTION_LEN } from './tokenProfile.ts';

const SRC = join(import.meta.dirname, '..');
const REPO = join(SRC, '..', '..');

const FACTORY = readFileSync(join(REPO, 'contracts/factory/src/lib.rs'), 'utf8');

/**
 * One named constant out of the Rust, as a bigint.
 *
 * Throws rather than returning null, because a constant that has been renamed must stop
 * this suite rather than silently remove a pin - the failure mode every assertion below
 * exists to prevent. The `ok` carries the name so the message says which one moved.
 */
function rustConst(name: string, type: string): bigint {
  const m = new RegExp(`pub const ${name}: ${type} = ([\\d_]+);`).exec(FACTORY);
  assert.ok(m, `${name} is no longer declared as \`${type}\` in the factory; this pin is now vacuous`);
  return BigInt(m[1].replace(/_/g, ''));
}

const CURVE_VIRTUAL_QUOTE_WHOLE = rustConst('CURVE_VIRTUAL_QUOTE_WHOLE', 'u128');
const CURVE_VIRTUAL_TOKENS = rustConst('CURVE_VIRTUAL_TOKENS', 'u128');
const CURVE_SUPPLY = rustConst('CURVE_SUPPLY', 'u128');
const GRADUATION_NUM = rustConst('GRADUATION_NUM', 'u128');
const GRADUATION_DEN = rustConst('GRADUATION_DEN', 'u128');

test('the curve shape in the browser is the curve shape in the contract', () => {
  /*
   * The two token figures are NOT scaled by the quote on either side - every token this
   * factory launches is 18 decimals - so these are a direct comparison.
   */
  assert.equal(
    FIXED_CURVE.virtualTokens,
    CURVE_VIRTUAL_TOKENS,
    'the virtual token reserve drifted, so every price the form quotes is off a curve nobody deployed',
  );
  assert.equal(
    FIXED_CURVE.curveSupply,
    CURVE_SUPPLY,
    'the curve supply drifted, so the opening-buy ceiling and the LP reserve are both wrong',
  );
  assert.equal(
    OPENING_RESERVE_QUOTE,
    Number(CURVE_VIRTUAL_QUOTE_WHOLE),
    'the default opening reserve drifted, so a launch opens at a market cap the form did not state',
  );
});

test('the two token figures are different numbers, so pinning both is not one pin twice', () => {
  /*
   * ANTI-VACUITY. If `virtual_tokens` and `curve_supply` were equal the two assertions
   * above would be interchangeable, and a mirror that had swapped them would pass. They
   * are 1.073e27 and 8e26 and the ratio is the curve's steepness, so this also records
   * that the difference is load-bearing rather than incidental.
   */
  assert.notEqual(CURVE_VIRTUAL_TOKENS, CURVE_SUPPLY);
  assert.ok(
    CURVE_VIRTUAL_TOKENS > CURVE_SUPPLY,
    'the virtual reserve no longer exceeds the sellable supply, which is what keeps the ' +
      'price finite at the top of the curve',
  );
});

test('graduation is the contract ratio, floored, at every scale', () => {
  /*
   * NOT ONE POINT. `graduationWholeFor` hardcodes `* 17n / 6n`, and a single-value check
   * passes for any pair with the same quotient at that value - 34/12, or even a bare
   * constant 1915. So this drives the client helper against the Rust's own arithmetic
   * across scales, including the 6-decimal shape measured on the deployed E2EUSD curves
   * on 16 Oct 2026 (`virtual_inj` 5354000000, `graduation_target` 15169000000).
   */
  const contract = (whole: bigint) => (whole * GRADUATION_NUM) / GRADUATION_DEN;

  for (const whole of [1n, 7n, 60n, CURVE_VIRTUAL_QUOTE_WHOLE, 5_354n, 1_000_000n]) {
    assert.equal(
      graduationWholeFor(whole),
      contract(whole),
      `the graduation ratio disagrees with the factory at ${whole} whole units`,
    );
  }

  /*
   * And it FLOORS, matching `multiply_ratio`. 676 * 17 / 6 is 1915.33, so the default is
   * itself a remainder case - a client rounding up would publish a target the curve never
   * reaches, and the launch would sit one unit short of graduating forever.
   */
  assert.equal(graduationWholeFor(CURVE_VIRTUAL_QUOTE_WHOLE), 1_915n);
  assert.ok(
    (CURVE_VIRTUAL_QUOTE_WHOLE * GRADUATION_NUM) % GRADUATION_DEN !== 0n,
    'the default reserve now divides exactly, so the floor above is no longer exercised; ' +
      'pick another remainder case',
  );
});

test('the 18-decimal literals in FIXED_CURVE are the whole-unit constants, scaled', () => {
  /*
   * `FIXED_CURVE` carries `virtualInj` and `graduationTarget` as base-unit literals, which
   * is a THIRD copy of the opening reserve: 676 lives in the Rust, in
   * `OPENING_RESERVE_QUOTE`, and again inside `676_000_000_000_000_000_000n`. Editing the
   * named constant without the literal leaves the default-quote curve on the old shape
   * while every piece of copy quotes the new one.
   */
  const unit = 10n ** 18n;
  assert.equal(
    FIXED_CURVE.virtualInj,
    CURVE_VIRTUAL_QUOTE_WHOLE * unit,
    'the base-unit opening reserve no longer matches the whole-unit constant it duplicates',
  );
  assert.equal(
    FIXED_CURVE.graduationTarget,
    graduationWholeFor(CURVE_VIRTUAL_QUOTE_WHOLE) * unit,
    'the base-unit graduation target no longer matches the ratio applied to the reserve',
  );
});

test('fixedCurveFor builds what the factory builds, for a quote that is not the default', () => {
  /*
   * The arithmetic, not the constants: the factory's `fixed_curve` scales ONLY the two
   * quote figures by `10^decimals` and leaves the token figures alone. A client that
   * scaled all four, or none, agrees with every constant above and still signs a different
   * curve - which is how the 18-decimal figures came to draw a 6-decimal curve a trillion
   * times too large.
   *
   * The fixture is the deployed E2EUSD pair, so this is pinned to a measurement rather
   * than to a rearrangement of the same expression.
   */
  const built = fixedCurveFor({ decimals: 6, virtualWhole: 5_354 });
  assert.equal(built.virtualInj, 5_354_000_000n, 'the opening reserve is not in the quote\u2019s units');
  assert.equal(built.graduationTarget, 15_169_000_000n, 'the graduation target is not in the quote\u2019s units');
  assert.equal(built.virtualTokens, CURVE_VIRTUAL_TOKENS, 'the token reserve must not be scaled by the quote');
  assert.equal(built.curveSupply, CURVE_SUPPLY, 'the curve supply must not be scaled by the quote');

  // And the default quote still comes out as the stored 18-decimal curve.
  const inj = fixedCurveFor(18);
  assert.equal(inj.virtualInj, FIXED_CURVE.virtualInj);
  assert.equal(inj.graduationTarget, FIXED_CURVE.graduationTarget);
});

test('the string ceilings the form enforces are the ones the factory enforces', () => {
  /*
   * These are the cheapest mirror to get wrong and the most annoying to hit: a form that
   * accepts 300 characters of description spends a signature and a launch fee to be told
   * no. `usize`, not `u128`, so they need their own type in the pattern - which is itself
   * why `rustConst` takes the type rather than matching `\w+`: a constant that changed
   * type has probably changed meaning.
   */
  assert.equal(
    BigInt(MAX_URI_LEN),
    rustConst('MAX_URI_LEN', 'usize'),
    'the URI length mirror drifted',
  );
  assert.equal(
    BigInt(MAX_DESCRIPTION_LEN),
    rustConst('MAX_DESCRIPTION_LEN', 'usize'),
    'the description length mirror drifted',
  );
});

test('the e2e script\u2019s fallback reserve is the contract default, not a stale copy', () => {
  /*
   * `e2e-testnet.mjs` falls back to a bare `'676'` when the factory reports no reserve for
   * the quote, and computes every expected figure in the run from it. A drift there does
   * not fail the script - it asserts the old curve against the new one and reports the
   * CONTRACT as wrong, which is the worst direction for a pre-mainnet check to fail in.
   */
  const e2e = readFileSync(join(REPO, 'scripts/e2e-testnet.mjs'), 'utf8');
  const fallback = /virtual_quote_whole \?\? '(\d+)'/.exec(e2e);
  assert.ok(fallback, 'the e2e fallback reserve moved; find it and re-pin it, or drop this guard');
  assert.equal(
    BigInt(fallback[1]),
    CURVE_VIRTUAL_QUOTE_WHOLE,
    'the e2e script would measure the testnet against an opening reserve the factory does not use',
  );
});
