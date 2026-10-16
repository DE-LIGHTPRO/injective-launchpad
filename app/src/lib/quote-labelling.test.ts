import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { fixedCurveFor, graduationWholeFor, openingReserveWholeFor } from './launchLimits.ts';

/**
 * Is a launch's money labelled with the launch's own quote?
 *
 * THE DEFECT THIS EXISTS FOR. Every money figure on the board and the launch page
 * was rendered with `NETWORK.quoteSymbol` and scaled with a literal 18, which was
 * correct for exactly as long as every launch was priced in INJ. Adding a second
 * quote asset made all of them wrong at once: Injective's USDC is 6 decimals, so a
 * USDC-paired launch rendered amounts a trillion times too large under the ticker of
 * an asset it was not in.
 *
 * That is not an approximation, it is a different number wearing the wrong name, and
 * nothing about it looks wrong on screen. No runtime test catches it either, because
 * with one quote allowlisted the default is also the right answer and every
 * assertion passes.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * Components that render figures belonging to a SPECIFIC launch.
 *
 * Not every use of the default is a defect: a page describing the launchpad, a
 * wallet prompt, or the curve explorer's hypothetical launch are all about the
 * platform, where the network's own quote is the correct and only answer. The list
 * is the surfaces showing money that some particular curve holds.
 */
const PER_LAUNCH = [
  'components/FeeEarnings.tsx',
  'components/TradePanel.tsx',
  'components/Trades.tsx',
  'components/LaunchList.tsx',
  'components/KingOfTheHill.tsx',
  'components/CurveChart.tsx',
  'components/PairPanels.tsx',
  'app/launch/[slug]/page.tsx',
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/[^\n]*/g, '');
}

test('no per-launch figure is labelled with the network default quote', () => {
  const offenders: string[] = [];
  for (const rel of PER_LAUNCH) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    for (const m of src.matchAll(/NETWORK\.quote(Symbol|Decimals|Denom)/g)) {
      offenders.push(`${rel}: NETWORK.quote${m[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a launch's own amounts are being rendered in the network's default quote",
  );
});

test('gas is a separate concept from the default quote', () => {
  /*
   * `NETWORK.quoteDenom` was doing double duty as "the default quote" and "what gas
   * is paid in". They are the same denom on Injective, so code reserving gas reached
   * for `quoteDenom` and was right by luck, and the guard above could not tell that
   * use from a launch's amounts being mislabelled.
   *
   * Separating them is better than exempting the call: the code now says which it
   * means, and the guard stays strict instead of growing a hole that the next
   * genuine defect would fit through.
   */
  const cfg = readFileSync(join(SRC, 'lib/config.ts'), 'utf8');
  assert.match(cfg, /gasDenom:\s*string/, 'gas has no name of its own');
  const panel = readFileSync(join(SRC, 'components/TradePanel.tsx'), 'utf8');
  assert.ok(
    !/gasReserveFor\([^)]*quoteDenom\)/.test(panel),
    'the gas reserve is reading the default quote again',
  );
});

test('the per-launch list still covers the components that exist', () => {
  /*
   * A guard listing files by name goes stale silently: a component renamed or split
   * leaves the list passing while the new file is unchecked. This fails instead.
   */
  for (const rel of PER_LAUNCH) {
    assert.doesNotThrow(
      () => readFileSync(join(SRC, rel), 'utf8'),
      `${rel} is in the per-launch list and does not exist`,
    );
  }
});

test('every component rendering money takes a quote to render it in', () => {
  /*
   * The positive half. Passing the two halves of a quote as separate props is how
   * one gets missed, so they travel as one object and a component either has it or
   * does not.
   */
  const needsQuote = ['components/FeeEarnings.tsx', 'components/TradePanel.tsx', 'components/Trades.tsx'];
  for (const rel of needsQuote) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    assert.ok(
      /quote(Asset)?:\s*Quote/.test(src),
      `${rel} renders amounts and does not accept a Quote`,
    );
  }
});

test('no per-launch surface hardcodes a ticker as a literal', () => {
  /*
   * THE SPELLING THE FIRST VERSION MISSED. This guard looked for
   * `NETWORK.quoteSymbol`, and `CurveChart` did not use it: its axis read the bare
   * string "INJ", typed directly into the JSX. The test passed while the chart on a
   * USDC launch was labelled INJ and scaled by 1e18, drawing an axis that ran to
   * 0.000000000085 for a launch graduating at 85 USDC.
   *
   * A guard that catches one way of writing a defect is not a guard against the
   * defect. This one looks for the ticker itself.
   *
   * `quoteLabel = 'INJ'` as a DEFAULT is allowed: it is the correct answer for the
   * default quote and the callers that show a specific launch override it.
   */
  const offenders: string[] = [];
  for (const rel of PER_LAUNCH) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    for (const m of src.matchAll(/\bINJ\b/g)) {
      const around = src.slice(Math.max(0, m.index! - 40), m.index! + 10);
      if (/quoteLabel\s*=\s*'$/.test(src.slice(0, m.index!).slice(-14))) continue;
      offenders.push(`${rel}: …${around.replace(/\s+/g, ' ').trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'a ticker is hardcoded on a per-launch surface');
});

test('the curve axis derives its scale from the quote, not a constant', () => {
  /*
   * WHAT THE TEXT GUARDS ABOVE CANNOT SEE. Mutation-checked: reverting
   * `unitFor(quoteDecimals)` to `unitFor(18)` leaves every other test in this file
   * green, because nothing about that change is a string. The label would be right
   * and the axis would run to 0.000000000085 on a launch graduating at 85 USDC.
   *
   * A guard built from source text catches how a defect is SPELLED. The scale is
   * arithmetic, so it needs its own assertion, and this is the cheapest one that
   * actually binds: the unit must come from the prop.
   */
  const src = stripComments(readFileSync(join(SRC, 'components/CurveChart.tsx'), 'utf8'));
  assert.match(
    src,
    /unitFor\(\s*quoteDecimals\s*\)/,
    'the curve axis is scaled by a constant rather than by the launch\u2019s quote',
  );
  assert.ok(
    !/const ONE = \d/.test(src),
    'a hardcoded unit is back in CurveChart',
  );
  /*
   * And the quote is not optional. A default here is what let `CreateLaunch` call the
   * chart bare for a year's worth of commits, so restoring one to make a new call site
   * compile would reopen the defect without changing a single line of the chart's maths.
   */
  for (const prop of ['quoteLabel', 'quoteDecimals']) {
    assert.ok(
      !new RegExp(`${prop}\\s*[=?]`).test(src),
      `${prop} is optional or defaulted again, so a call site can omit the launch\u2019s quote`,
    );
  }
});

/** Every `.tsx` under `src/`, so a guard over call sites cannot go stale by omission. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every curve chart is handed the quote it is drawing', () => {
  /*
   * WHAT THE GUARD ABOVE CANNOT SEE, AND THE DEFECT IT LET THROUGH. `quoteLabel` and
   * `quoteDecimals` are optional props defaulting to INJ at 18 decimals, which is
   * right for the default pair, so `CurveChart` passed every assertion in this file
   * while `CreateLaunch` called it bare. With the 6-decimal E2EUSD pair selected the
   * chart on the create screen read `0 INJ raised` and `0.0 INJ`, under the caption
   * "Drawn from the same maths the contract charges, so this is the shape buyers will
   * actually pay", beside a row saying the curve tops out at 15,689.37 E2EUSD.
   *
   * A default that is correct for the default case is not a safe default: it reinstates
   * the defect at any call site that forgets, silently, and checking that the component
   * USES a prop is not checking that anyone PASSES it. So this reads the call sites,
   * found by walking the tree rather than listed, since a new chart added later is the
   * case a named list would miss.
   *
   * Both props are now REQUIRED, so `tsc` refuses a bare call and this test is the
   * second line rather than the first. It is still the one that binds, because what
   * `tsc` cannot see is somebody restoring the default to make a new call site compile,
   * which is exactly how the defect got in. The test below pins that too.
   */
  const sites: string[] = [];
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<CurveChart\b([\s\S]*?)\/>/g)) {
      const rel = file.slice(SRC.length + 1);
      sites.push(rel);
      for (const prop of ['quoteLabel', 'quoteDecimals']) {
        if (!new RegExp(`\\b${prop}=`).test(m[1])) offenders.push(`${rel}: no ${prop}`);
      }
    }
  }
  // Anti-vacuity: a rename would otherwise leave this passing over nothing.
  assert.ok(sites.length >= 2, `expected the chart to be used, found ${sites.length} call sites`);
  assert.deepEqual(offenders, [], 'a curve chart is drawing a launch in the default quote');
});

test('the create form states the reserve the chosen pair actually opens at', () => {
  /*
   * THE SAME DEFECT IN COPY RATHER THAN IN ARITHMETIC, and the worse half: the two rows
   * it broke are badged "fixed" and are the terms of something a creator can never
   * change afterwards. `OPENING_RESERVE_QUOTE` is 676, documented in its own file as
   * "only the INJ default, for copy that is about the launchpad rather than about a
   * launch", and the form printed it beside whatever ticker was SELECTED:
   *
   *     Graduates at E2EUSD raised   1915 E2EUSD   fixed
   *     Opening reserve              676 E2EUSD    fixed
   *     Curve ceiling                15,689.37 E2EUSD
   *
   * Measured on both deployed E2EUSD curves, 16 Oct 2026: `virtual_inj` 5354000000 and
   * `graduation_target` 15169000000, i.e. 5354 and 15169 whole E2EUSD. The ceiling row
   * is built through `fixedCurveFor` and matched the chain, so the card disagreed with
   * itself and the figure that was right was the one not badged fixed.
   */
  const src = stripComments(readFileSync(join(SRC, 'components/CreateLaunch.tsx'), 'utf8'));
  for (const constant of ['OPENING_RESERVE_QUOTE', 'GRADUATION_TARGET_QUOTE']) {
    assert.ok(
      !src.includes(constant),
      `the create form prints ${constant}, which is the INJ default, beside the selected pair\u2019s ticker`,
    );
  }
  assert.match(
    src,
    /openingReserveWholeFor\(/,
    'the create form is not resolving the opening reserve from the chosen quote',
  );
});

test('the stated terms are the terms of the curve that gets signed', () => {
  /*
   * The assertion that binds the arithmetic rather than the spelling. A card stating
   * one reserve and signing another is the failure; these two must come out of the same
   * place for every quote, including a factory too old to report one.
   */
  for (const [decimals, virtualWhole] of [
    [18, undefined],
    [6, 5_354],
    [6, undefined],
    [18, 676],
  ] as Array<[number, number | undefined]>) {
    const quote = { decimals, ...(virtualWhole === undefined ? {} : { virtualWhole }) };
    const curve = fixedCurveFor(quote);
    const unit = 10n ** BigInt(decimals);
    const stated = openingReserveWholeFor(quote);
    assert.equal(
      curve.virtualInj,
      BigInt(stated) * unit,
      `the form would state ${stated} and the curve opens at ${curve.virtualInj}`,
    );
    assert.equal(
      curve.graduationTarget,
      graduationWholeFor(stated) * unit,
      'the form would state a graduation target the curve does not have',
    );
  }
  // Anti-vacuity: the per-quote reserve is a different number, so resolving it matters.
  assert.notEqual(
    openingReserveWholeFor({ virtualWhole: 5_354 }),
    openingReserveWholeFor({}),
  );
});
