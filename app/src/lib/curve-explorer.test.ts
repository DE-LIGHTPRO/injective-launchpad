/**
 * The homepage handle said one thing and pointed at another.
 *
 * `CurveExplorer` is the first thing a visitor is taught about how this launchpad
 * prices a token, and its docblock claims every number on it is real. Its `t` is a
 * fraction of the GRADUATION TARGET, which every figure in the readout was computed
 * at, while the handle's x was `t * maxX` - a fraction of the curve's CEILING, which
 * is 3.44% further right. So the handle sat on a point of the curve whose price was
 * not the price printed underneath it: up to 23.4px apart on a 704px plot, the price
 * at the drawn position up to 5.16% above the one displayed, and at full travel a
 * readout of 1,915.00 under a handle on 1,980.95. The axis label under it called the
 * ceiling "(graduation)", which is what made the gap unreadable.
 *
 * THIS IS THE SECOND TIME. `CurveChart` had already found, fixed and documented the
 * identical defect, and `curve-chart.test.ts` ends on the reason it did not
 * propagate: positioning that lives inline in a component is out of reach of every
 * test. So the fix here is not a second copy of the arithmetic - the explorer calls
 * the same `chartMarker`, over the same `stateAtRaised` that builds the line - and
 * this file pins both the behaviour and the delegation that keeps it reachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chartMarker,
  stateAtRaised,
  curvePoints,
  spotPrice,
  maxCollectable,
  type CurveConfig,
} from './curve.ts';
import { fixedCurveFor, DEFAULT_FEE_BPS } from './launchLimits.ts';

const ONE = 10n ** 18n;

/** The shape the component draws: the real one a new launch gets, in INJ units. */
const SHAPE: CurveConfig = {
  ...fixedCurveFor(18),
  feeBps: BigInt(DEFAULT_FEE_BPS),
  feeSellBps: BigInt(DEFAULT_FEE_BPS),
};

const whole = (v: bigint) => Number(v) / Number(ONE);

const rawSource = readFileSync(
  join(import.meta.dirname, '..', 'components', 'CurveExplorer.tsx'),
  'utf8',
);
/*
 * Comments stripped before any source assertion. The component documents the two
 * expressions it must no longer use, so a guard reading the raw file flags the
 * explanation of the fix as the fix being absent.
 */
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/[^\n]*/g, '');

test('the two maxima the handle mixed are genuinely different', () => {
  /*
   * Anti-vacuity. If the ceiling and the target were the same number the old
   * expression would have been correct and nothing below could fail.
   */
  const ceiling = maxCollectable(SHAPE);
  assert.ok(ceiling > SHAPE.graduationTarget, 'the ceiling must sit beyond the target');
  const over = Number(ceiling) / Number(SHAPE.graduationTarget);
  // 1.0344 on the shipped shape: 1980.95 against 1915. Pinned loosely; the point is
  // that it is not 1.
  assert.ok(over > 1.03 && over < 1.04, `unexpected overshoot ${over}`);
});

test('the handle lands on the amount the readout prints, at every position', () => {
  /*
   * The defect, as the component experiences it. `t` runs over the target, so the
   * handle has to land on `t * target` and not on `t * ceiling`.
   */
  const axisMax = whole(maxCollectable(SHAPE));
  for (const t of [0, 0.18, 0.33, 0.5, 0.75, 0.9, 1]) {
    const raised = BigInt(Math.round(t * Number(SHAPE.graduationTarget)));
    const { injX } = chartMarker(SHAPE, stateAtRaised(SHAPE, raised), axisMax, ONE);
    assert.ok(
      Math.abs(injX - whole(raised)) < 1e-6,
      `at t=${t} the handle is at ${injX} and the readout says ${whole(raised)}`,
    );
    // And explicitly not where the old expression put it.
    if (t > 0) assert.ok(injX < t * axisMax, `the handle still overshoots at t=${t}`);
  }
});

test('at full travel the handle sits on the graduation target, not the curve ceiling', () => {
  /*
   * The worst single reading, and the one a visitor is most likely to look at:
   * dragging to the end used to put the handle on 1980.95 over a readout of 1915.00.
   */
  const axisMax = whole(maxCollectable(SHAPE));
  const { injX } = chartMarker(SHAPE, stateAtRaised(SHAPE, SHAPE.graduationTarget), axisMax, ONE);
  assert.ok(Math.abs(injX - whole(SHAPE.graduationTarget)) < 1e-6, `full travel lands on ${injX}`);
  assert.ok(axisMax - injX > 60, 'the premise changed: the ceiling is no longer past the target');
});

test('the handle height is the price at the position it is drawn at', () => {
  /*
   * Not the price at some other point on the curve, which is the same defect in the
   * vertical. An earlier version computed the height from its own inverted copy of
   * the curve formula and floated the handle above the line everywhere but the ends.
   */
  /*
   * ASSERTED AGAINST THE DRAWN LINE, not against a formula. This read
   * `assert.equal(price, whole(spotPrice(SHAPE, st, ONE)))`, which pinned the exact
   * expression `chartMarker` used rather than the property that matters, and that
   * expression floored every price to zero on a 6-decimal quote. A test that encodes
   * a claim is only as good as the claim. "The handle sits on the line" is the claim,
   * and `curvePoints` is the line, so compare the two.
   */
  const axisMax = whole(maxCollectable(SHAPE));
  const samples = 60;
  const pts = curvePoints(SHAPE, ONE, samples);
  for (const i of [6, 30, 57]) {
    // A state at exactly a sampled position, so the dot and that sample must agree.
    const raised = (maxCollectable(SHAPE) * BigInt(i)) / BigInt(samples);
    const st = stateAtRaised(SHAPE, raised);
    const { price } = chartMarker(SHAPE, st, axisMax, ONE);
    assert.equal(price, pts[i].price, `the handle is off the line at sample ${i}`);
    assert.ok(price > 0, 'a drawable position must have a price');
  }
  // Rising, because this curve's price rises with the reserve. An inverted formula
  // fails here rather than merely disagreeing by a hair.
  const at = (t: number) =>
    chartMarker(
      SHAPE,
      stateAtRaised(SHAPE, BigInt(Math.round(t * Number(SHAPE.graduationTarget)))),
      whole(maxCollectable(SHAPE)),
      ONE,
    ).price;
  assert.ok(at(0.9) > at(0.5) && at(0.5) > at(0.1), 'the handle height does not rise with reserves');
});

test('the handle sits on the drawn line, because both come from one derivation', () => {
  /*
   * The component had a SECOND COPY of `stateAtRaised` that divided plainly where
   * `curvePoints` rounds the token reserve up, so the quote under the handle came
   * from a state one unit off the line it was drawn against. One unit in 10^18 is
   * invisible and that is the argument for the shared function, not against it: the
   * duplication is what let the x-axis defect survive a fix made two files away.
   */
  const pts = curvePoints(SHAPE, ONE, 80);
  for (const i of [0, 20, 40, 79, 80]) {
    const raised = BigInt(Math.round(pts[i].injRaised * Number(ONE)));
    const st = stateAtRaised(SHAPE, raised);
    const price = whole(spotPrice(SHAPE, st, ONE));
    // Rounding through a float costs a few ulps at 18 decimals; relative, not absolute.
    assert.ok(
      Math.abs(price - pts[i].price) / pts[i].price < 1e-9,
      `sample ${i}: the line says ${pts[i].price} and the handle says ${price}`,
    );
  }

  // Anti-vacuity: the discarded copy really did produce a different state.
  const raised = SHAPE.graduationTarget / 2n;
  const plain = SHAPE.virtualTokens - (SHAPE.virtualInj * SHAPE.virtualTokens) / (SHAPE.virtualInj + raised);
  const shared = stateAtRaised(SHAPE, raised).tokensSold;
  assert.notEqual(plain, shared, 'the two derivations agree, so this guard proves nothing');
  // Rounded toward the pool, so the shared one sells strictly fewer tokens.
  assert.ok(shared < plain, 'the shared derivation no longer rounds the reserve up');
});

test('the explorer delegates its position rather than computing one inline', () => {
  /*
   * STRUCTURE, which is the half no behavioural test can see and the half that
   * actually failed: every assertion above passes while the component ignores all of
   * it and places the handle from its own arithmetic. That is exactly how the fix in
   * `CurveChart` came to be absent here.
   */
  assert.match(source, /chartMarker\(SHAPE, state, maxX, ONE\)/, 'the explorer no longer delegates');
  assert.match(source, /stateAtRaised\(SHAPE, raised\)/, 'the explorer derives its own state again');
  assert.ok(
    !/t\s*\*\s*maxX/.test(source),
    'the handle is positioned against the ceiling again',
  );
  assert.ok(
    !/spotPrice\s*\(/.test(source),
    'the handle height is computed outside the marker again',
  );
});

test('the axis names the ceiling the ceiling, and marks where graduation is', () => {
  /*
   * The label is not cosmetic: the handle stops 3.44% short of the end of its own
   * track, and without a mark there the stop reads as the control being broken. The
   * right-hand label used to read "(graduation)" over the ceiling, on the homepage,
   * which taught every visitor the wrong target.
   */
  assert.match(source, /curve ceiling/, 'the ceiling is not named');
  assert.ok(!/\(graduation\)/.test(source), 'the ceiling is labelled graduation again');
  assert.match(source, /graduates at \{targetX/, 'nothing marks where graduation happens');
});
