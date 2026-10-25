import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { quoteBuyWithPremium, quoteSell, type CurveConfig, type CurveState } from './curve.ts';

/**
 * Does `curve.ts` reproduce, unit for unit, what the chain actually answered?
 *
 * AUDIT F-08. The client re-implements the bonding curve in TypeScript, and that
 * arithmetic prints "you will receive X" above the button. The audit rated it Info and
 * said one sample matched; the exposure is not Info-shaped, because a systematic
 * divergence would be wrong for every trade on every launch, silently, in the one
 * number this product exists to state before anybody signs. `contract-mirror.test.ts`
 * pins the CONSTANTS the two sides share. Nothing compared their OUTPUTS.
 *
 * THESE FIXTURES ARE THE CHAIN'S OWN ANSWERS, not expectations somebody wrote down.
 * Captured 25 Oct 2026 from live testnet curves through `SimulateBuy`/`SimulateSell`,
 * which are free smart queries: five launches at two different base fee rates, 30 buy
 * samples from 10^12 base units to 1000 INJ, 9 sell samples scaled off what each curve
 * had actually sold. `scripts/curve-parity.mjs` is what produced them and what re-runs
 * the comparison live; this file is the half that cannot silently stop being true.
 *
 * Exact equality, no tolerance. The contract works in integers and so does `curve.ts`;
 * a tolerance here would be a place for a rounding defect to live, and rounding is the
 * whole difficulty - `feeOn` rounds up and the premium floors, each on purpose, so that
 * the pool is never short.
 *
 * WHAT THIS DOES NOT COVER, stated because a green run should not be read as more than
 * it is:
 *
 *  - `early_fee_premium`. The deployed curves run an older code id than
 *    `contracts/curve` and do not report the field, so the premium path is compared
 *    against nothing. It is asserted below as deliberately absent rather than skipped
 *    quietly, so this reads as a gap and not as coverage.
 *  - The opening window. The premium decays with time and the two sides read different
 *    clocks: the browser's `Date.now()` against the contract's block time. No launch
 *    was inside a window when these were captured, so that path is unexercised here
 *    and the skew is a real difference between the quote shown and the fill.
 *  - Dust. The contract refuses an `inj_in` of 1 base unit outright ("amount must be
 *    greater than zero" after its own scaling), where `curve.ts` will quote it. Nothing
 *    is lost - the buy cannot execute either way - and the pre-sign simulation now
 *    refuses it before a prompt rather than after.
 */

interface Fixture {
  ticker: string;
  curve: string;
  config: Record<string, string | number>;
  state: Record<string, string | number>;
  buys: Array<{ injIn: string; chain: Record<string, string | boolean> }>;
  sells: Array<{ tokensIn: string; chain: Record<string, string | boolean> }>;
}

const FIXTURES: Fixture[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'testing', 'curve-parity-fixtures.json'), 'utf8'),
);

/** Fixtures are JSON, so every amount came back a string. */
function asConfig(raw: Record<string, string | number>): CurveConfig {
  return {
    virtualInj: BigInt(raw.virtualInj),
    virtualTokens: BigInt(raw.virtualTokens),
    curveSupply: BigInt(raw.curveSupply),
    graduationTarget: BigInt(raw.graduationTarget),
    feeBps: BigInt(raw.feeBps),
    feeSellBps: BigInt(raw.feeSellBps),
  };
}

function asState(raw: Record<string, string | number>): CurveState {
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = BigInt(v);
  return out as unknown as CurveState;
}

test('every buy the chain priced is priced identically here', () => {
  let checks = 0;
  for (const f of FIXTURES) {
    const cfg = asConfig(f.config);
    const st = asState(f.state);
    for (const { injIn, chain } of f.buys) {
      // Premium zero: these were all captured outside any opening window. See the
      // docblock on why a window cannot be compared this way at all.
      const js = quoteBuyWithPremium(cfg, st, BigInt(injIn), 0n);
      const where = `${f.ticker} buy ${injIn}`;
      assert.equal(js.tokensOut, BigInt(chain.tokens_out as string), `${where}: tokens_out`);
      assert.equal(js.fee, BigInt(chain.fee as string), `${where}: fee`);
      assert.equal(js.refund, BigInt(chain.refund as string), `${where}: refund`);
      assert.equal(js.graduates, Boolean(chain.graduates), `${where}: graduates`);
      checks += 4;
    }
  }
  assert.ok(checks >= 100, `only ${checks} field comparisons: the fixtures are not being read`);
});

test('every sell the chain priced is priced identically here', () => {
  let checks = 0;
  for (const f of FIXTURES) {
    const cfg = asConfig(f.config);
    const st = asState(f.state);
    for (const { tokensIn, chain } of f.sells) {
      const js = quoteSell(cfg, st, BigInt(tokensIn));
      const where = `${f.ticker} sell ${tokensIn}`;
      assert.equal(js.injOut, BigInt(chain.inj_out as string), `${where}: inj_out`);
      assert.equal(js.fee, BigInt(chain.fee as string), `${where}: fee`);
      checks += 2;
    }
  }
  assert.ok(checks >= 10, `only ${checks} sell comparisons: sells are not being exercised`);
});

test('the fixtures span more than one curve, one fee rate and one order of magnitude', () => {
  /*
   * A parity suite that happens to hold one launch at one size would pass while the
   * arithmetic was wrong everywhere else, and would read exactly like this one. The
   * audit's own note was that "the sample matched", which is the claim this guards
   * against inheriting.
   */
  assert.ok(FIXTURES.length >= 3, `only ${FIXTURES.length} curves captured`);
  const fees = new Set(FIXTURES.map((f) => String(f.config.feeBps)));
  assert.ok(fees.size >= 2, `every fixture uses the same base fee (${[...fees].join(', ')})`);
  const sizes = FIXTURES.flatMap((f) => f.buys.map((b) => BigInt(b.injIn)));
  assert.ok(sizes.length >= 20, `only ${sizes.length} buy samples`);
  const span = sizes.reduce((a, b) => (b > a ? b : a), 0n) / sizes.reduce((a, b) => (b < a ? b : a), sizes[0]);
  assert.ok(span >= 1_000_000n, `the largest buy is only ${span}x the smallest; this is one size`);
  // A refund is only produced by a buy large enough to empty a curve, and a suite with
  // none has never exercised the branch that hands money back.
  assert.ok(
    FIXTURES.some((f) => f.buys.some((b) => BigInt(b.chain.refund as string) > 0n)),
    'no captured buy produced a refund, so the curve-emptying branch is unverified',
  );
});

test('the premium field is a known gap, not quiet coverage', () => {
  /*
   * The deployed code predates `early_fee_premium`, so the chain never sent one. If a
   * later capture includes it, this fails and the buy test above must start comparing
   * it - which is the point: a gap that closes itself silently is a gap nobody revisits.
   */
  const reported = FIXTURES.flatMap((f) => f.buys).filter(
    (b) => b.chain.early_fee_premium !== undefined,
  );
  assert.equal(
    reported.length,
    0,
    'the chain now reports early_fee_premium: add it to the buy comparison, it is no longer a gap',
  );
});
