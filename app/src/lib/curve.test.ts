/**
 * Parity and property tests for the TypeScript curve maths.
 *
 * The parity vectors are READ FROM `curve-vectors.json`, which the Rust side
 * writes:
 *
 *     npm run vectors
 *
 * Those numbers are the chain's truth. If the TypeScript drifts from them by a
 * single unit, the quote the UI shows is a lie and trades near the graduation
 * boundary revert on slippage.
 *
 * WHY A FILE RATHER THAN A PASTED TABLE. This used to hold the generator's
 * stdout, copied in by hand, with the instruction "regenerate and re-paste if
 * you change the Rust". The numbers were genuinely Rust-derived, so the
 * provenance was real — but its currency depended on somebody remembering.
 * Change the Rust, skip the paste, and every assertion below keeps passing
 * against stale vectors while the UI quotes prices the contract will refuse.
 * The failure is silent in exactly the case the test exists for.
 *
 * THE CONFIG IS CHECKED FIRST. Both sides used to hardcode their own
 * `CurveConfig`, matching only by coincidence. Change either and the vectors
 * describe a different curve while every parity assertion still passes, because
 * each side is internally consistent and they are no longer talking about the
 * same thing. The generator now emits its config and `CFG` is asserted against
 * it, so the comparison is known to be like-for-like before any number is
 * trusted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  quoteBuy,
  quoteSell,
  feeOn,
  maxCollectable,
  spotPrice,
  graduationProgress,
  parseAmount,
  priceImpactBps,
  sellPriceImpactBps,
  poolQuoteBuy,
  poolQuoteSell,
  poolBuyImpactBps,
  poolSellImpactBps,
  IMPACT_SEVERE_BPS,
  fmt,
  validate,
  CurveError,
  type CurveConfig,
  type CurveState,
} from './curve.ts';

const ONE = 1_000_000_000_000_000_000n;
const amt = (n: bigint) => n * ONE;

const CFG: CurveConfig = {
  virtualInj: amt(30n),
  virtualTokens: amt(1_073_000_000n),
  curveSupply: amt(800_000_000n),
  graduationTarget: amt(85n),
  feeBps: 100n,
};

const fresh = (): CurveState => ({
  injCollected: 0n,
  tokensSold: 0n,
  graduated: false,
});

/*
 * The vectors, as the Rust wrote them.
 *
 * Read eagerly so a missing or malformed file fails loudly here rather than
 * leaving each parity test to pass over an empty list. A parity suite that
 * silently compares nothing is worse than no parity suite: it reports the one
 * thing it cannot know.
 */
const VECTORS_PATH = join(import.meta.dirname, 'curve-vectors.json');

interface Row { kind: string; from?: string; label?: string; [k: string]: unknown }

function loadVectors(): Row[] {
  let raw: string;
  try {
    raw = readFileSync(VECTORS_PATH, 'utf8');
  } catch (e) {
    /*
     * ONLY a missing file means "not generated yet".
     *
     * A bare `catch` here reported "curve-vectors.json is missing" for a
     * ReferenceError thrown inside the try: this block sat below `WARM`, which
     * calls it while the module is still evaluating, so `VECTORS_PATH` was in
     * the temporal dead zone. The file was present the whole time. A catch that
     * reports one cause for every failure sends you to fix the wrong thing,
     * which cost real minutes here.
     */
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    throw new Error(
      `curve-vectors.json is missing. Generate it with \`npm run vectors\`, which runs ` +
        `the Rust that these numbers must match.`,
    );
  }
  const rows = JSON.parse(raw) as Row[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('curve-vectors.json is empty');
  return rows;
}

const VECTORS = loadVectors();
const big = (v: unknown): bigint => BigInt(String(v));
const rowsOf = (kind: string, from?: string): Row[] =>
  VECTORS.filter((r) => r.kind === kind && (from === undefined || r.from === from));

/*
 * The warm state, read from the vectors rather than copied.
 *
 * It is itself a Rust output: the state after a 40 INJ buy. Pasting it had the
 * same staleness problem as the quote tables, and worse consequences, because
 * every warm assertion is measured against it.
 */
const WARM: CurveState = (() => {
  const row = loadVectors().find((r) => r.kind === 'state' && r.label === 'warm');
  if (!row) throw new Error('the vectors carry no warm state; regenerate with `npm run vectors`');
  return {
    injCollected: BigInt(String(row.injCollected)),
    tokensSold: BigInt(String(row.tokensSold)),
    graduated: false,
  };
})();

const PARITY_BUYS_FRESH = rowsOf('buy', 'fresh');
const PARITY_BUYS_WARM = rowsOf('buy', 'warm');
const PARITY_SELLS_WARM = rowsOf('sell', 'warm');

test('the vectors describe the same curve this test configures', () => {
  /*
   * Before a single quote is compared. Two implementations that each hardcode
   * their own config will agree on nothing and report agreement on everything.
   */
  const cfgRow = VECTORS.find((r) => r.kind === 'config');
  assert.ok(cfgRow, 'the vectors carry no config row; regenerate with `npm run vectors`');
  assert.equal(big(cfgRow.virtualInj), CFG.virtualInj, 'virtualInj');
  assert.equal(big(cfgRow.virtualTokens), CFG.virtualTokens, 'virtualTokens');
  assert.equal(big(cfgRow.curveSupply), CFG.curveSupply, 'curveSupply');
  assert.equal(big(cfgRow.graduationTarget), CFG.graduationTarget, 'graduationTarget');
  assert.equal(BigInt(Number(cfgRow.feeBps)), CFG.feeBps, 'feeBps');
});

test('every buy and sell vector carries an impact figure to compare', () => {
  // Added after the vectors existed, so an older file would compare nothing:
  // `Number(undefined)` is NaN and would fail, but obscurely. This says why.
  for (const r of [...PARITY_BUYS_FRESH, ...PARITY_BUYS_WARM, ...PARITY_SELLS_WARM]) {
    assert.ok(
      r.impactBps !== undefined,
      'a buy vector has no impactBps; regenerate with `npm run vectors`',
    );
  }
});

test('the impact on this curve is large enough to be worth disclosing', () => {
  /*
   * Not a tautology: this is the justification for showing it at all, pinned so a
   * future change that flattens the curve also flags that the warning thresholds
   * want revisiting. 25 INJ into a fresh curve pays about 82% above spot, while the
   * fee disclosed beside it is 1%.
   */
  const impact = priceImpactBps(CFG, fresh(), 25n * ONE);
  assert.ok(impact > IMPACT_SEVERE_BPS, `25 INJ should be severe, got ${impact}bps`);
  assert.ok(impact > 8_000 && impact < 8_500, `expected roughly 82%, got ${impact}bps`);
});

test('sell impact is below everything structurally, not by clamping', () => {
  /*
   * The Rust had this test and the TypeScript did not, which mutation found:
   * removing the 100% cap here failed nothing. A guard on one side of a mirrored
   * pair is the asymmetry these two files exist to prevent.
   *
   * A sell cannot be worth less than nothing, so 10,000 bps is the floor of what
   * can be received, and the arithmetic cannot produce more. Asserting the bound
   * STRICTLY is what makes this test mean something: `<=` would hold even if the
   * formula were wrong in a way that saturated.
   */
  const thin: CurveState = { injCollected: 1_000n, tokensSold: ONE, graduated: false };
  const bps = sellPriceImpactBps(CFG, thin, ONE);
  // STRICTLY below, which is the point. There was a clamp at 10,000 here and
  // mutation showed removing it failed nothing: the branch above returns 0 when
  // actual >= atSpot, so 0 <= actual < atSpot and the quotient is under 10,000 for
  // every input. Swept across extreme states the maximum observed is 9999, so a
  // clamp could never engage and an assertion of `<= 10000` passed vacuously.
  assert.ok(bps < 10_000, `impact reached or exceeded 100%: ${bps}bps`);
  assert.ok(bps > 9_000, `this state should sit near the limit, got ${bps}bps`);
});

test('there are vectors of every kind to compare', () => {
  // A filter that matches nothing makes a for-loop a no-op, and a no-op test is
  // green. Assert the counts rather than trusting the file's shape.
  assert.ok(PARITY_BUYS_FRESH.length >= 5, `fresh buys: ${PARITY_BUYS_FRESH.length}`);
  assert.ok(PARITY_BUYS_WARM.length >= 3, `warm buys: ${PARITY_BUYS_WARM.length}`);
  assert.ok(PARITY_SELLS_WARM.length >= 3, `warm sells: ${PARITY_SELLS_WARM.length}`);
  assert.ok(
    PARITY_BUYS_FRESH.some((r) => r.graduates === true),
    'no fresh-buy vector reaches graduation, which is where rounding matters most',
  );
});

test('buys match the Rust maths exactly, from a fresh curve', () => {
  for (const row of PARITY_BUYS_FRESH) {
    const q = quoteBuy(CFG, fresh(), big(row.injIn));
    assert.equal(q.fee, big(row.fee), `fee for ${row.injIn}`);
    assert.equal(q.injInAfterFee, big(row.net), `net for ${row.injIn}`);
    assert.equal(q.tokensOut, big(row.tokensOut), `tokensOut for ${row.injIn}`);
    assert.equal(q.refund, big(row.refund), `refund for ${row.injIn}`);
    assert.equal(q.graduates, row.graduates, `graduates for ${row.injIn}`);
    assert.equal(
      priceImpactBps(CFG, fresh(), big(row.injIn)),
      Number(row.impactBps),
      `impactBps for ${row.injIn}`,
    );
  }
});

test('buys match the Rust maths exactly, part way along the curve', () => {
  for (const row of PARITY_BUYS_WARM) {
    const q = quoteBuy(CFG, WARM, big(row.injIn));
    assert.equal(q.fee, big(row.fee), `fee for ${row.injIn}`);
    assert.equal(q.injInAfterFee, big(row.net), `net for ${row.injIn}`);
    assert.equal(q.tokensOut, big(row.tokensOut), `tokensOut for ${row.injIn}`);
    assert.equal(q.refund, big(row.refund), `refund for ${row.injIn}`);
    assert.equal(q.graduates, row.graduates, `graduates for ${row.injIn}`);
    assert.equal(
      priceImpactBps(CFG, WARM, big(row.injIn)),
      Number(row.impactBps),
      `impactBps for ${row.injIn}`,
    );
  }
});

test('sells match the Rust maths exactly', () => {
  for (const row of PARITY_SELLS_WARM) {
    const q = quoteSell(CFG, WARM, big(row.tokensIn));
    assert.equal(q.fee, big(row.fee), `fee for ${row.tokensIn}`);
    assert.equal(q.injOut, big(row.injOut), `injOut for ${row.tokensIn}`);
    assert.equal(
      sellPriceImpactBps(CFG, WARM, big(row.tokensIn)),
      Number(row.impactBps),
      `sell impactBps for ${row.tokensIn}`,
    );
  }
});

test('the warm state itself is reproducible from a 40 INJ buy', () => {
  const q = quoteBuy(CFG, fresh(), amt(40n));
  assert.equal(q.injInAfterFee, WARM.injCollected);
  assert.equal(q.tokensOut, WARM.tokensSold);
});

test('a round trip never returns more than was spent', () => {
  for (const n of [1n, 7n, 40n, 85n]) {
    const sent = amt(n);
    const b = quoteBuy(CFG, fresh(), sent);
    const st: CurveState = {
      injCollected: b.injInAfterFee,
      tokensSold: b.tokensOut,
      graduated: false,
    };
    const s = quoteSell(CFG, st, b.tokensOut);
    const spent = sent - b.refund;
    assert.ok(s.injOut <= spent, `round trip profited: spent ${spent}, got ${s.injOut}`);
  }
});

test('500 dust round trips cannot drain the pool', () => {
  const noFee: CurveConfig = { ...CFG, feeBps: 0n };
  const seed = quoteBuy(noFee, fresh(), amt(10n));
  const st: CurveState = {
    injCollected: seed.injInAfterFee,
    tokensSold: seed.tokensOut,
    graduated: false,
  };
  const start = st.injCollected;

  for (let i = 0; i < 500; i++) {
    const b = quoteBuy(noFee, st, 1_000n);
    st.injCollected += b.injInAfterFee;
    st.tokensSold += b.tokensOut;
    const s = quoteSell(noFee, st, b.tokensOut);
    st.injCollected -= s.injOut;
    st.tokensSold -= b.tokensOut;
  }
  assert.ok(st.injCollected >= start, `drained: ${start} -> ${st.injCollected}`);
});

test('price rises with every buy', () => {
  const st = fresh();
  let last = -1n;
  for (let i = 0; i < 30; i++) {
    const q = quoteBuy(CFG, st, amt(1n));
    if (last >= 0n) assert.ok(q.tokensOut < last, 'price did not rise');
    last = q.tokensOut;
    st.injCollected += q.injInAfterFee;
    st.tokensSold += q.tokensOut;
  }
});

test('an oversized buy is capped and every unit is accounted for', () => {
  const sent = amt(10_000n);
  const q = quoteBuy(CFG, fresh(), sent);
  assert.equal(q.tokensOut, CFG.curveSupply, 'should take the whole curve');
  assert.equal(q.fee + q.injInAfterFee + q.refund, sent, 'value created or destroyed');
  assert.ok(q.graduates);
});

test('an unreachable graduation target is rejected', () => {
  assert.throws(
    () => validate({ ...CFG, graduationTarget: amt(10_000n) }),
    CurveError,
  );
});

test('trading is refused once graduated', () => {
  const st: CurveState = { injCollected: amt(85n), tokensSold: amt(500n), graduated: true };
  assert.throws(() => quoteBuy(CFG, st, amt(1n)), CurveError);
  assert.throws(() => quoteSell(CFG, st, amt(1n)), CurveError);
});

test('fees round up, toward the pool', () => {
  assert.equal(feeOn(1n, 100n), 1n);
  assert.equal(feeOn(0n, 100n), 0n);
  assert.equal(feeOn(10_000n, 100n), 100n);
});

test('maxCollectable sits just above the graduation target', () => {
  const max = maxCollectable(CFG);
  assert.ok(max > CFG.graduationTarget, 'target is unreachable');
  assert.ok(max < amt(100n), 'suspiciously large headroom');
});

test('spot price and progress move the right way', () => {
  const early = spotPrice(CFG, fresh(), ONE);
  const later = spotPrice(CFG, WARM, ONE);
  assert.ok(later > early);
  assert.equal(graduationProgress(CFG, fresh()), 0);
  assert.ok(graduationProgress(CFG, WARM) > 0.4);
  assert.equal(
    graduationProgress(CFG, { ...fresh(), injCollected: amt(200n) }),
    1,
  );
});

test('amount parsing and formatting round trip', () => {
  assert.equal(parseAmount('1'), ONE);
  assert.equal(parseAmount('1.5'), ONE + ONE / 2n);
  assert.equal(parseAmount('0.000000000000000001'), 1n);
  assert.equal(fmt(ONE), '1');
  assert.equal(fmt(ONE + ONE / 2n), '1.5');
  assert.throws(() => parseAmount('abc'), CurveError);
});

test('the committed vectors are what the Rust produces right now', (t) => {
  /*
   * THE HALF THAT READING A FILE DOES NOT FIX.
   *
   * Reading `curve-vectors.json` removes the copy-paste step, but the file is
   * still committed, so it can go stale the moment the Rust changes and nobody
   * runs `npm run vectors`. Every assertion above would keep passing against
   * numbers the contract no longer produces, which is the precise failure this
   * suite exists to prevent, one level up.
   *
   * So the generator is re-run and its output compared. Where cargo is absent
   * the check SKIPS LOUDLY rather than passing: a drift check that reports green
   * on a machine it could not run is worse than no drift check, because it
   * answers a question it never asked.
   */
  let fresh: string;
  try {
    fresh = execFileSync(
      'cargo',
      ['run', '-q', '--manifest-path', '../Cargo.toml', '-p', 'launchpad-math', '--example', 'parity'],
      { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      t.skip('cargo is not on this machine, so Rust/TypeScript drift was NOT checked');
      return;
    }
    throw e;
  }

  // Compared as parsed values, not as text: whitespace is not a divergence, and
  // a formatting change in the generator should not read as a maths change.
  const committed = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  assert.deepEqual(
    JSON.parse(fresh),
    committed,
    'curve-vectors.json is stale: the Rust produces different numbers. Run `npm run vectors`, ' +
      'then check what changed before committing it, because the UI quotes these.',
  );
});

// ------------------------------------------------------------------ locked pool --

test('pool buys and sells match the Rust to the unit', () => {
  const poolRow = VECTORS.find((r) => r.kind === 'pool');
  assert.ok(poolRow, 'the vectors carry no pool row; regenerate with `npm run vectors`');
  const pool = { quote: big(poolRow.quote), tokens: big(poolRow.tokens) };
  const feeBps = BigInt(Number(poolRow.feeBps));
  const buys = rowsOf('poolBuy');
  const sells = rowsOf('poolSell');
  assert.ok(buys.length >= 3 && sells.length >= 3, 'too few pool vectors to compare');
  for (const r of buys) {
    const q = poolQuoteBuy(pool, feeBps, big(r.injIn));
    assert.equal(q.fee, big(r.fee), `pool buy fee for ${r.injIn}`);
    assert.equal(q.quoteInAfterFee, big(r.net), `pool buy net for ${r.injIn}`);
    assert.equal(q.tokensOut, big(r.tokensOut), `pool buy tokensOut for ${r.injIn}`);
    assert.equal(poolBuyImpactBps(pool, feeBps, big(r.injIn)), Number(r.impactBps));
  }
  for (const r of sells) {
    const q = poolQuoteSell(pool, feeBps, big(r.tokensIn));
    assert.equal(q.fee, big(r.fee), `pool sell fee for ${r.tokensIn}`);
    assert.equal(q.injOut, big(r.injOut), `pool sell injOut for ${r.tokensIn}`);
    assert.equal(poolSellImpactBps(pool, feeBps, big(r.tokensIn)), Number(r.impactBps));
  }
});

test('a pool round trip never returns more than was spent', () => {
  let pool = { quote: 85n * ONE, tokens: 207_000_000n * ONE };
  for (const n of [1n, 7n, 50n, 400n]) {
    const spent = (n * ONE) / 10n;
    const b = poolQuoteBuy(pool, 0n, spent);
    const after = { quote: pool.quote + b.quoteInAfterFee, tokens: pool.tokens - b.tokensOut };
    const s = poolQuoteSell(after, 0n, b.tokensOut);
    assert.ok(s.injOut <= spent, `round trip of ${n} returned ${s.injOut} for ${spent}`);
    pool = after;
  }
});

// ---------------------------------------------------------- 6-decimal quotes --

import { marketCapExact, spotPriceWad, PRICE_WAD } from './curve.ts';
import { fixedCurveFor, FIXED_TOTAL_SUPPLY } from './launchLimits.ts';

test('a 6-decimal launch has a real market cap and price, not zero', () => {
  // Seen live: PAIR5277 held 9.90 TUSD and showed market cap 0.00, because the
  // per-token price was floored to a whole TUSD base unit before multiplying.
  const cfg = { ...fixedCurveFor(6), feeBps: 100n };
  const st = { injCollected: 0n, tokensSold: 0n, graduated: false };
  const mc = marketCapExact(cfg, st, null, FIXED_TOTAL_SUPPLY);
  // 60 * 1B / 1.073B = 55.919 whole units, the same figure an INJ launch shows.
  // It doubled with the opening reserve when the curve was scaled 30/85 -> 60/170.
  assert.equal(mc, 55_917_986n, `market cap ${mc}`);
  const wad = spotPriceWad(cfg, st, null, ONE);
  assert.ok(wad > 0n, 'the wad price must not floor to zero');
  // Same shape as INJ: identical price once each is read at its own decimals.
  const inj = spotPriceWad({ ...fixedCurveFor(18), feeBps: 100n }, st, null, ONE);
  assert.equal(inj / 10n ** 12n, wad, 'the curve shape differs between 6 and 18 decimals');
  assert.ok(PRICE_WAD === 10n ** 18n);
});

test('the 18-decimal fixed curve is exactly the factory constants', () => {
  const c = fixedCurveFor(18);
  assert.equal(c.virtualInj, 60n * ONE);
  assert.equal(c.graduationTarget, 170n * ONE);
  assert.equal(fixedCurveFor(6).virtualInj, 60_000_000n);
});
