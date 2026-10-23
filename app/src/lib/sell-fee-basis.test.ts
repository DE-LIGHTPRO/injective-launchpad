/**
 * AN EXIT PAYS THE SELL FEE, AND THREE OF THE FOUR PLACES THAT PRICED ONE READ THE
 * BUY FEE.
 *
 * `CurveConfigStored` carries `fee_bps` and `fee_sell_bps`, the factory caps the two
 * independently, and its own comment calls pricing entry and exit differently "a real
 * choice about their own launch". Four pieces of code priced an exit. Only `exec_sell`
 * read the right field:
 *
 *   exec_sell        fee_sell_bps     correct
 *   exec_pool_sell   fee_bps          a creator's exit fee silently stopped applying
 *                                     at graduation, with nothing saying it expires
 *   SimulateSell     fee_bps          both branches, so a caller sizing an exit was
 *                                     quoted proceeds the contract will not pay
 *   quoteSell (TS)   feeBps           the type had no sell fee at all, so the panel
 *                                     and `min_inj_out` were built from the buy rate
 *
 * Measured on the deployed shape with 1% entry and 10% exit, selling the whole of a
 * 20-quote buy:
 *
 *      panel  inj_out 98.010000  fee 0.990000
 *      chain  inj_out 89.100000  fee 9.900000      panel overstates by 10.000%
 *      tolerance 0.5% / 1% / 3% / 5%: min_inj_out REVERTS (Slippage)
 *      tolerance 10%: fills, and the seller silently loses 8.91 against the figure
 *      they were shown
 *
 * WHY NOTHING CAUGHT IT, established rather than assumed. Every Rust fixture sets
 * `fee_bps: 100, fee_sell_bps: 100`, so `simulate_sell_is_exactly_what_executing_does`
 * could not discriminate: a fixture where the two fields are equal cannot tell them
 * apart. And the parity vectors structurally cannot, because `launchpad_math`'s
 * `CurveConfig` carries ONE `fee_bps` - the sell side is implemented by swapping
 * `fee_sell_bps` into it - so there is no Rust row for an asymmetric sell fee to
 * disagree with. That is the same structural blindness that hid the opening premium,
 * recorded in `early-fee-basis.test.ts`.
 *
 * So this file is the discriminating fixture the suite did not have: free entry and
 * the maximum 10% exit, the two extremes the factory allows, where a consumer reading
 * the buy fee charges nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  quoteBuy,
  quoteSell,
  poolQuoteSell,
  effectiveFeeBps,
  validate,
  CurveError,
  type CurveConfig,
  type CurveState,
  type PoolReserves,
} from './curve.ts';
import { fixedCurveFor } from './launchLimits.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const CONTRACT = join(SRC, '..', '..', 'contracts', 'curve', 'src', 'contract.rs');
const PANEL = join(SRC, 'components', 'TradePanel.tsx');

const ONE = 10n ** 18n;

/**
 * Free entry, 10% exit. Both ends of what the factory permits, chosen so a consumer
 * that reads the wrong field is wrong by the whole fee rather than by nothing.
 */
const ASYMMETRIC: CurveConfig = { ...fixedCurveFor(18), feeBps: 0n, feeSellBps: 1_000n };
const FRESH: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };

/** A warm curve, reached by a real buy rather than invented. */
function warm(cfg: CurveConfig, injIn: bigint): { st: CurveState; tokens: bigint } {
  const b = quoteBuy(cfg, FRESH, injIn);
  return {
    st: { injCollected: b.injInAfterFee, tokensSold: b.tokensOut, graduated: false },
    tokens: b.tokensOut,
  };
}

test('a curve sell is skimmed at the sell fee, not the buy fee', () => {
  const { st, tokens } = warm(ASYMMETRIC, 20n * ONE);
  const q = quoteSell(ASYMMETRIC, st, tokens);
  const gross = q.injOut + q.fee;

  // 10% of the gross, floored, because the contract's `multiply_ratio` floors.
  assert.equal(q.fee, (gross * 1_000n) / 10_000n, 'the curve sell fee is not the sell rate');

  /*
   * ANTI-VACUITY. The fixture has to be able to tell the two fields apart, and with
   * `feeBps: 0n` the version that shipped charged nothing, so this is the whole
   * difference rather than a rounding one.
   */
  assert.ok(q.fee > 0n, 'the sell fee is zero, so this fixture cannot discriminate');
  assert.notEqual(
    q.fee,
    (gross * ASYMMETRIC.feeBps) / 10_000n,
    'the sell is still skimmed at the buy rate',
  );
});

test('a pool sell is skimmed at the sell fee too, because it does not expire', () => {
  /*
   * The launch-window rules expire at graduation and `exec_pool_buy`'s docblock
   * enumerates exactly which: the wallet cap, the start time, the opening premium. A
   * venue fee is not one of them, and `LaunchPreview` renders "buy fee / sell fee"
   * unqualified, so a creator who set a 10% exit is promising their holders a 10%
   * exit on both venues. `exec_pool_sell` charged the buy fee, so that promise
   * silently lapsed the moment the curve filled.
   */
  const pool: PoolReserves = { quote: 1_915n * ONE, tokens: 400_000_000n * ONE };
  const tokensIn = 1_000_000n * ONE;
  const charged = poolQuoteSell(pool, ASYMMETRIC.feeSellBps, tokensIn);
  const atTheBuyRate = poolQuoteSell(pool, ASYMMETRIC.feeBps, tokensIn);
  assert.ok(charged.fee > 0n, 'the pool sell fee is zero, so this cannot discriminate');
  assert.ok(
    charged.injOut < atTheBuyRate.injOut,
    'the pool pays the same either way, so the two rates are not distinguishable here',
  );
});

test('a quote built from the buy fee is refused as slippage at every usual tolerance', () => {
  /*
   * The defect as a seller met it. `min_inj_out` is derived from the panel's figure
   * and enforced on chain, so an overstated quote is not a bad price: it is a refused
   * trade reported as slippage, for a trade where nothing moved.
   */
  const { st, tokens } = warm(ASYMMETRIC, 20n * ONE);
  const delivered = quoteSell(ASYMMETRIC, st, tokens).injOut;

  // What the panel used to show: the same curve maths, skimmed at the buy rate.
  const asItShipped = quoteSell({ ...ASYMMETRIC, feeSellBps: ASYMMETRIC.feeBps }, st, tokens);
  assert.ok(asItShipped.injOut > delivered, 'the old basis no longer overstates proceeds');

  for (const toleranceBps of [50n, 100n, 300n, 500n]) {
    const minOut = (asItShipped.injOut * (10_000n - toleranceBps)) / 10_000n;
    assert.ok(
      delivered < minOut,
      `the old basis no longer reverts at ${Number(toleranceBps) / 100}%, so this no longer measures it`,
    );
  }

  // And what ships now asks for exactly what the contract pays.
  assert.equal(quoteSell(ASYMMETRIC, st, tokens).injOut, delivered);
});

test('a launch stored before the field existed has free exits, not buy-rate exits', () => {
  /*
   * `fee_sell_bps` is `#[serde(default)]` on the contract side, so such a curve
   * answers without it and charges nothing on exit. `chain.ts` reads that as 0 rather
   * than substituting the buy fee, which would invent a charge the chain will not
   * make. Consistent with the chain either way is the property; the value is that
   * launch's.
   */
  const mapper = readFileSync(join(SRC, 'lib', 'chain.ts'), 'utf8');
  assert.match(
    maskComments(mapper),
    /feeSellBps: BigInt\(raw\.fee_sell_bps \?\? 0\)/,
    'the chain mapper no longer defaults a missing sell fee to zero',
  );
});

test('both fee ceilings are checked, because the factory caps them independently', () => {
  // `launchpad_math`'s `validate` sees one fee and so cannot reach the sell side at
  // all. This is the only place that can, and it checked only the buy fee.
  assert.throws(() => validate({ ...fixedCurveFor(18), feeBps: 1_001n, feeSellBps: 0n }), CurveError);
  assert.throws(() => validate({ ...fixedCurveFor(18), feeBps: 0n, feeSellBps: 1_001n }), CurveError);
  assert.doesNotThrow(() => validate(ASYMMETRIC));
});

test('the contract prices every exit through the one sell-fee helper', () => {
  /*
   * Four consumers, one source. Pinned by the PROPERTY each line has to carry rather
   * than by its whole spelling: that an exit's rate comes from `sell_fee_bps` and a
   * curve exit quotes against `sell_curve`. Three of these four read `cfg.curve.fee_bps`
   * when this was written, and each was locally plausible.
   */
  const rs = maskComments(readFileSync(CONTRACT, 'utf8'));

  assert.match(
    rs,
    /fn sell_fee_bps\(cfg: &Config\) -> u16 \{\s*cfg\.curve\.fee_sell_bps\s*\}/,
    'the sell fee no longer resolves to fee_sell_bps',
  );
  assert.match(
    rs,
    /fn sell_curve\(cfg: &Config\) -> CurveConfig \{[\s\S]*?sell_cfg\.fee_bps = sell_fee_bps\(cfg\);/,
    'a curve sell quote no longer swaps the sell fee into the curve config',
  );

  // Both curve-side consumers: exec_sell and the SimulateSell curve branch.
  const curveQuotes = rs.match(/quote_sell\(&sell_curve\(&cfg\), &state\.curve_state\(\)/g) ?? [];
  assert.equal(curveQuotes.length, 2, `${curveQuotes.length} curve sell quotes read sell_curve, expected 2`);

  // Both pool-side consumers: exec_pool_sell and the SimulateSell migrated branch.
  const poolQuotes = rs.match(/pool_quote_sell\(&state\.pool\(\), sell_fee_bps\(&cfg\)/g) ?? [];
  assert.equal(poolQuotes.length, 2, `${poolQuotes.length} pool sell quotes read sell_fee_bps, expected 2`);

  /*
   * And the field itself is reached nowhere else. This is the assertion that would
   * have failed on the code that shipped: `fee_sell_bps` appeared exactly once, in
   * `exec_sell`, while three other places priced an exit from `fee_bps`.
   */
  const direct = rs.match(/fee_sell_bps/g) ?? [];
  assert.equal(
    direct.length,
    1,
    `fee_sell_bps is read at ${direct.length} places; it belongs only inside sell_fee_bps`,
  );
});

test('the panel labels and prices an exit at the sell rate', () => {
  /*
   * The row said "Fee · 1%" above a figure that was 10% of the gross, because the
   * label read the buy fee while the amount came from the quote. Anchored to the
   * operands, not to the surrounding JSX, which moves (see the re-anchoring in
   * `fee-ceiling-claims.test.ts`).
   */
  const tsx = maskComments(readFileSync(PANEL, 'utf8'));
  /*
   * THIS PINNED THE OLD REMEDY AND NOT THE CLAIM. It asserted two literals,
   * `const sellBps = Number(config.feeSellBps)` and the ternary that chose between
   * the two constants, which is one correct way to label the row and not the only
   * one. Audit F-11 then found the buy side of that same ternary wrong for a
   * different reason - `chargedBps` is the SUM of the opening premium and the curve's
   * fee, where the amount beside it is the two applied in sequence - and the fix is
   * to measure the rate out of the amount for both sides. These assertions failed on
   * that fix while the claim they exist to defend held, so they now assert the claim:
   * the exit's rate comes from the exit's own numbers.
   */
  assert.match(
    tsx,
    /effectiveFeeBps\(\s*feeCharged,[\s\S]*?okQuote\.injOut/,
    'the fee row no longer measures an exit rate out of the exit quote',
  );
  assert.ok(
    !/\bsellBps\b/.test(tsx),
    'a separate exit-rate constant is back, and a second copy of a rate is what drifted',
  );
  /*
   * The behavioural half, which the literals never covered: a 10% exit on a launch
   * whose entry is free has to read 10%, and reading it off the amount is what makes
   * that true without the panel naming a rate at all.
   */
  const { st, tokens } = warm(ASYMMETRIC, 50n * ONE);
  const s = quoteSell(ASYMMETRIC, st, tokens / 2n);
  const bps = effectiveFeeBps(s.fee, s.injOut);
  assert.ok(bps !== null, 'an exit with proceeds behind it has a rate');
  assert.equal((bps / 100).toFixed(2), '10.00', 'the exit rate is not the sell fee');
  assert.match(
    tsx,
    /poolQuoteSell\(pool, config\.feeSellBps/,
    'a pool sell quote no longer charges the sell fee',
  );
  assert.match(
    tsx,
    /poolSellImpactBps\(pool, config\.feeSellBps/,
    'pool sell impact is no longer measured at the sell fee',
  );
});
