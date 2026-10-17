/**
 * The chart's marker says where a launch is, and it said the wrong place.
 *
 * The x axis runs to `maxCollectable`, the curve's ceiling, which is NOT the
 * graduation target: 87.912 against 85 on the shape this project ships, a ratio of
 * 1.0343. The marker was positioned at `maxX * graduationProgress`, and
 * `graduationProgress` divides by the target while `maxX` is the ceiling, so it sat
 * 3.4% further right than the launch actually was at every point along the curve.
 * At graduation it landed on the ceiling rather than on the target it was marking:
 * a launch drawn as past the point it had just graduated at.
 *
 * Small numbers, and a fair question is whether it matters. It does, because the
 * marker's whole job is to say "you are here" against a shape, and 85 is the point
 * the shape exists to reach. A marker that overshoots the target at 100% is not
 * imprecise, it is pointing at the wrong thing.
 *
 * These tests pin the arithmetic that made it possible rather than the pixels: the
 * two quantities genuinely differ, so anything conflating them is wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maxCollectable,
  graduationProgress,
  curvePoints,
  chartMarker,
  stateAtRaised,
  spotPrice,
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

const chartRaw = readFileSync(join(import.meta.dirname, '..', 'components', 'CurveChart.tsx'), 'utf8');

/*
 * Comments stripped before any source assertion.
 *
 * The component's own comment explains the old expression it must no longer use, so
 * a guard reading the raw file flagged the documentation of the fix as the bug. The
 * prose describing a defect is not the defect, and this is the third guard in these
 * projects to need the same treatment.
 */
const chart = chartRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/[^\n]*/g, '');

test('the curve ceiling is not the graduation target, which is why the bug existed', () => {
  // If these were equal the old positioning would have been correct and this whole
  // file would be pointless. They are not, and the chart has to respect that.
  const ceiling = maxCollectable(CFG);
  assert.notEqual(ceiling, CFG.graduationTarget);
  assert.ok(ceiling > CFG.graduationTarget, 'the ceiling must sit beyond the target');
  // 1.0343 on this shape. Pinned loosely: the point is that it is not 1.
  const ratio = Number(ceiling) / Number(CFG.graduationTarget);
  assert.ok(ratio > 1.03 && ratio < 1.04, `unexpected ratio ${ratio}`);
});

test('the x axis the line is drawn on ends at the ceiling, not the target', () => {
  // The marker shares this axis, so this is the domain it has to be placed against.
  const pts = curvePoints(CFG, ONE, 20);
  const last = pts[pts.length - 1].injRaised;
  assert.ok(
    Math.abs(last - Number(maxCollectable(CFG)) / Number(ONE)) < 1e-6,
    `the axis ends at ${last}, not at the ceiling`,
  );
});

test('positioning by progress would overshoot, positioning by what was raised does not', () => {
  /*
   * The defect and the fix, as arithmetic. At every state the old expression lands
   * further right than the launch is, and the new one lands exactly on it.
   */
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  for (const raised of [2.97, 20, 42.5, 70, 85]) {
    const st: CurveState = {
      injCollected: BigInt(Math.round(raised * 1e18)),
      tokensSold: 0n,
      graduated: false,
    };
    const old = maxX * graduationProgress(CFG, st);
    const fixed = Number(st.injCollected) / Number(ONE);
    assert.ok(old > fixed, `at ${raised} the old position did not overshoot`);
    assert.ok(Math.abs(fixed - raised) < 1e-6, `the fixed position is not the raised amount`);
  }

  // And at graduation the old expression lands on the ceiling rather than the target.
  const atTarget: CurveState = { injCollected: CFG.graduationTarget, tokensSold: 0n, graduated: false };
  assert.ok(Math.abs(maxX * graduationProgress(CFG, atTarget) - maxX) < 1e-9, 'premise changed');
});

test('the marker lands on what was raised, at every state', () => {
  /*
   * BEHAVIOUR, not source text. The first version of this asserted the component
   * mentioned `injCollected` and did not contain the string `maxX * progress`, and a
   * mutation that rewrote the overshoot in different words passed it. Asserting on
   * the text of a calculation does not test the calculation.
   */
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  for (const raised of [0, 2.97, 20, 42.5, 70, 85]) {
    const st: CurveState = {
      injCollected: BigInt(Math.round(raised * 1e18)),
      tokensSold: 0n,
      graduated: false,
    };
    const { injX } = chartMarker(CFG, st, maxX, ONE);
    assert.ok(Math.abs(injX - raised) < 1e-6, `at ${raised} INJ the marker is at ${injX}`);
    // And explicitly not where the old expression put it.
    const overshoot = maxX * graduationProgress(CFG, st);
    if (raised > 0) assert.ok(injX < overshoot, `the marker still overshoots at ${raised}`);
  }
});

test('the marker is clamped to the axis rather than drawn off the end', () => {
  // A state past the ceiling is possible to construct, and the chart should still
  // render with the marker at the end rather than outside the viewBox.
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  const past: CurveState = { injCollected: maxCollectable(CFG) * 2n, tokensSold: 0n, graduated: false };
  const { injX } = chartMarker(CFG, past, maxX, ONE);
  assert.equal(injX, maxX, 'the marker left the axis');
});

test('the marker height is the price at the state, on the line that is drawn', () => {
  /*
   * ASSERTED AGAINST `curvePoints`, not against a formula. This compared the marker to
   * `Number(spotPrice(CFG, st, ONE)) / Number(ONE)`, which pinned the exact expression
   * `chartMarker` used rather than the property that matters - and that expression
   * floors to zero on a 6-decimal quote, so the test defended the defect below. The
   * claim is "the dot is on the line", and `curvePoints` is the line.
   */
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  const samples = 70;
  const pts = curvePoints(CFG, ONE, samples);
  for (const i of [7, 35, 66]) {
    const raised = (maxCollectable(CFG) * BigInt(i)) / BigInt(samples);
    const { price } = chartMarker(CFG, stateAtRaised(CFG, raised), maxX, ONE);
    assert.equal(price, pts[i].price, `the marker is off the line at sample ${i}`);
    assert.ok(price > 0, 'a plottable state must produce a price');
  }
});

test('a 6-decimal quote draws a real curve, not a flat line on the baseline', () => {
  /*
   * THE ONE PAIR THIS PROJECT DEVELOPS AGAINST IS THE ONE IT CANNOT GO WRONG ON.
   *
   * `spotPrice` returns a bigint - whole quote base units per token - and on an
   * 18-decimal INJ quote that is a large number. On Injective's 6-decimal stablecoins
   * a token on this curve costs a fraction of one base unit, so it floored to 0 at
   * EVERY sampled position: `maxY` fell through to its `|| 1` guard and the entire
   * bonding curve was drawn as a flat line along the bottom of the card, with the
   * marker correctly sitting on it.
   *
   * `spotPriceWad` exists in `curve.ts` precisely because of this flooring, and its
   * docblock records the symptom - "every USDC launch showed price 0 and market cap 0".
   * That fix reached the price and market-cap readouts and never reached the chart.
   *
   * The config is the live E2EUSD launch, read from the chain on 17 Oct 2026.
   */
  const USD: CurveConfig = {
    virtualInj: 5_354_000_000n,
    virtualTokens: amt(1_073_000_000n),
    curveSupply: amt(800_000_000n),
    graduationTarget: 15_169_000_000n,
    feeBps: 100n,
  };
  const QUOTE_ONE = 1_000_000n;
  const pts = curvePoints(USD, QUOTE_ONE, 70);

  assert.equal(
    new Set(pts.map((p) => p.price)).size,
    pts.length,
    'the curve has repeated prices, so part of it is flat',
  );
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].price > pts[i - 1].price, `the curve does not rise at sample ${i}`);
  }
  /*
   * And the value is right, not merely non-zero: the opening price is the virtual
   * reserve over the virtual token supply, 5354 / 1,073,000,000 of a whole quote unit.
   * A fix that scaled by the wrong power of ten would pass every assertion above.
   */
  assert.ok(
    Math.abs(pts[0].price - 5354 / 1_073_000_000) < 1e-15,
    `the opening price is ${pts[0].price}, not the virtual reserve over the virtual supply`,
  );

  // The marker on that same curve has a height too, rather than lying on the axis.
  const maxX = Number(maxCollectable(USD)) / Number(QUOTE_ONE);
  const migratedUsd: CurveState = {
    injCollected: 0n,
    tokensSold: USD.curveSupply,
    graduated: true,
  };
  const { price } = chartMarker(USD, migratedUsd, maxX, QUOTE_ONE);
  const maxY = Math.max(...pts.map((p) => p.price));
  assert.ok(price > 0, 'the marker is back on the baseline');
  assert.ok(price > maxY * 0.9, `the marker at the target is only ${price / maxY} of the way up`);
});

test('an unplottable state loses the marker, not the whole chart', () => {
  /*
   * The line is still true even where the marker cannot be placed, so a bad state
   * returns a floor price rather than throwing and blanking the component. Nothing
   * about the curve's shape depends on where this launch happens to be.
   */
  const broken: CurveState = { injCollected: 0n, tokensSold: CFG.virtualTokens, graduated: false };
  const { price } = chartMarker(CFG, broken, 87.9, ONE);
  assert.equal(price, 0);
});

/*
 * A MIGRATED LAUNCH HAS NO RESERVE, AND READING THAT AS A POSITION DREW IT AT THE ORIGIN.
 *
 * `contracts/curve/src/contract.rs` sets `inj_collected` to zero at migration - the
 * reserve leaves the curve for the locked pool - and `tokens_sold` to the whole curve
 * supply. So the one number the marker was placed by stops being a position and becomes
 * a balance that is no longer held. Measured on the live testnet, 17 Oct 2026: a launch
 * with 800,000,000 of 800,000,000 sold and 6,724.38 quote locked rendered its progress
 * bar at 100% and its marker at x = 0, on the same card whose note says "the marker is
 * where this one has reached". Every other figure on the page was right.
 *
 * The state is not a point on the curve at all, so the position AND the price both have
 * to come from the shape. Those are two separate things a fix can get half of, which is
 * why they are asserted separately below.
 */
const MIGRATED: CurveState = {
  injCollected: 0n,
  tokensSold: CFG.curveSupply,
  graduated: true,
};

test('a migrated launch is drawn at its graduation target, not at the origin', () => {
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  const { injX } = chartMarker(CFG, MIGRATED, maxX, ONE);
  assert.ok(
    Math.abs(injX - Number(CFG.graduationTarget) / Number(ONE)) < 1e-6,
    `a launch that traversed the whole curve is drawn at ${injX}`,
  );
  assert.ok(injX > 0, 'the marker is back on the origin');
});

test('a migrated launch takes its price from the target too, not from its emptied state', () => {
  /*
   * The discriminating half. `reserves` reads the quote side from `injCollected`, which
   * migration zeroed, and the token side from `tokensSold`, which it maxed - so the
   * emptied state prices about 3.7x BELOW the curve at the target on this shape. A fix
   * that moved only the x position would put the dot on the axis at the right place and
   * well under the line it is drawn on.
   */
  const { price } = chartMarker(CFG, MIGRATED, Number(maxCollectable(CFG)) / Number(ONE), ONE);
  const fromEmptyState = Number(spotPrice(CFG, MIGRATED, ONE)) / Number(ONE);
  assert.ok(price > 0, 'a migrated launch has no marker height at all');
  assert.ok(
    price > fromEmptyState * 2,
    `the price came from the emptied state (${price} against ${fromEmptyState})`,
  );
});

test('a launch graduated but not yet migrated keeps its own reserve, which is the better figure', () => {
  /*
   * Expressed as a floor rather than a branch on migration for this case: graduation is
   * set on the buy that CROSSES the target, so the reserve sits at or just above it and
   * is a real position. Overwriting it with the target would move the marker backwards.
   */
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  const over = CFG.graduationTarget + amt(2n);
  const { injX } = chartMarker(CFG, { injCollected: over, tokensSold: 0n, graduated: true }, maxX, ONE);
  assert.ok(Math.abs(injX - 87) < 1e-6, `a graduated launch holding 87 INJ is drawn at ${injX}`);
});

test('the floor applies only to a graduated launch, so a fresh one still starts at zero', () => {
  /*
   * The mutation this exists for: flooring unconditionally puts every untraded launch at
   * its graduation target, which is the same defect pointing the other way and looks
   * perfectly plausible on a board of in-pool launches.
   */
  const maxX = Number(maxCollectable(CFG)) / Number(ONE);
  const fresh: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };
  assert.equal(chartMarker(CFG, fresh, maxX, ONE).injX, 0);
});

test('the component delegates the marker rather than computing it inline', () => {
  /*
   * The one source assertion worth keeping, and it is about STRUCTURE rather than
   * about a calculation: the positioning must stay in `chartMarker` where the tests
   * above can reach it. Re-inlining the arithmetic would move it back out of reach
   * and no behavioural test could see that.
   */
  assert.match(chart, /chartMarker\(config, state, maxX, ONE\)/, 'the chart no longer delegates');
  assert.ok(!/points\[Math\.round\(/.test(chart), 'the marker indexes the sample array again');
});

test('graduation is marked, because the axis runs past it', () => {
  // Without this the chart shows a curve continuing beyond a target it never
  // explains, which is what made the overshoot invisible.
  assert.match(chart, /config\.graduationTarget/, 'nothing marks where graduation happens');
});

test('the chart carries no colour literals', () => {
  /*
   * It was drawn in four hex values that each near-missed a token: #00d6a4 against
   * --accent #14e2ad, #222838 against --line-strong, #f0a44a against --warn
   * #f2b45c, #7d879e against --text-faint. Near-misses are worse than obvious
   * mistakes, because the chart simply reads as a slightly different green from
   * everything else on the page and nobody can say why.
   */
  const literals = chart.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(literals, null, `colour literals remain: ${literals?.join(', ')}`);
  for (const tok of ['--accent', '--warn', '--text-faint', '--line-strong']) {
    assert.ok(chart.includes(tok), `${tok} is not used`);
  }
});
