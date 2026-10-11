import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
});
