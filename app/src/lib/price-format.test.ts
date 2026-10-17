import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { priceDecimalText, priceParts, tickerHue } from './priceFormat.ts';
import { maskComments } from './testing/maskComments.ts';

const E18 = 10n ** 18n;

/*
 * These five drove `priceText`, which assembled the folded form as a plain string with
 * `₀₁₂₃...` characters. It had no call site, and the only purpose its docblock gave -
 * titles and share cards - is the case `priceDecimalText` exists to cover, because a
 * subscript digit is skipped by most screen readers and a title is read rather than
 * looked at. So the function is gone and the assertions moved onto `priceParts`, which
 * `Price.tsx` actually renders: the folding logic they test is the same logic, reached
 * the way the product reaches it.
 */
const PLAIN = (digits: string) => ({ lead: '', zeros: 0, digits });

test('a tiny price folds its zeros into a subscript', () => {
  // 0.0000002942 INJ, the demo launch's spot price.
  const raw = 294_200_000_000n; // 2.942e-7 at 18 decimals
  assert.deepEqual(priceParts(raw, 18), { lead: '0.0', zeros: 6, digits: '2942' });
});

test('a price with few zeros is printed plainly', () => {
  assert.deepEqual(priceParts(12_340_000_000_000_000n, 18), PLAIN('0.01234'));
  assert.deepEqual(priceParts(1_200_000_000_000_000n, 18), PLAIN('0.0012'));
});

test('prices at or above one are grouped, not folded', () => {
  assert.deepEqual(priceParts(1234n * E18 + 5n * 10n ** 17n, 18), PLAIN('1,234.5'));
  assert.deepEqual(priceParts(2n * E18, 18), PLAIN('2'));
});

test('works at six decimals, as a USDC-priced launch needs', () => {
  assert.deepEqual(priceParts(3n, 6), { lead: '0.0', zeros: 5, digits: '3' });
  assert.deepEqual(priceParts(300n, 6), PLAIN('0.0003'));
  assert.deepEqual(priceParts(1n, 9), { lead: '0.0', zeros: 8, digits: '1' });
});

test('zero and negatives are zero, never a minus sign or NaN', () => {
  assert.deepEqual(priceParts(0n, 18), PLAIN('0'));
  assert.deepEqual(priceParts(-5n, 18), PLAIN('0'));
});

/*
 * ------------------------------------------------------------------------------------
 * THE FOLDED FORM IS FOR EYES, AND ONLY EYES HAD IT.
 *
 * Read off the rendered launch page on 16 Oct 2026. ORBIT's spot price came out as
 *
 *     <span title="0.0₆63 INJ">0.0<sub class="px-zeros" aria-hidden="true">6</sub>63 INJ</span>
 *
 * The count of folded zeros is the only part of that carrying the magnitude, and it
 * was the one part hidden from the accessibility tree, with nothing put in its place.
 * A `<span>` holding text takes its accessible name from that text, so the announced
 * figure was "0.063 INJ" for a price of 0.00000063 INJ: a hundred thousand times over,
 * on the number somebody decides a trade on. `title` was a mouse tooltip and carried
 * the `₆` shorthand anyway.
 *
 * Checked against the contract rather than against the renderer, because an internally
 * consistent screen is not evidence: `virtual_inj / virtual_tokens` is
 * 676e18 / 1.073e27 = 6.3001e-7, and the fully diluted cap beside it reads 630.01 INJ
 * over a 1e9 supply. Both agree with the folded form and with each other. The visual
 * figure was right the whole time, which is exactly why nothing looked wrong.
 * ------------------------------------------------------------------------------------
 */

test('the written-out price keeps every zero the subscript folded', () => {
  // ORBIT, measured: 6.3001e-7 INJ per token, rendered 0.0₆63.
  assert.equal(priceDecimalText(630_010_000_000n, 18), '0.00000063');
  assert.equal(priceDecimalText(294_200_000_000n, 18), '0.0000002942');
  assert.equal(priceDecimalText(3n, 6), '0.000003');
  assert.equal(priceDecimalText(1n, 9), '0.000000001');
});

test('the written-out price is the same number as the folded one', () => {
  /*
   * ANTI-VACUITY, and the only assertion that can catch an off-by-one in the zero
   * count - which is the whole failure mode here, since `lead` already contains the
   * first zero and prefixing it as well would announce a price ten times too small.
   * Parsed back as a float and compared to the raw value, so the two renderings are
   * checked against the quantity rather than against each other.
   */
  for (const [raw, decimals] of [
    [630_010_000_000n, 18],
    [294_200_000_000n, 18],
    [12_340_000_000_000_000n, 18],
    [1234n * E18, 18],
    [3n, 6],
    [1n, 9],
  ] as Array<[bigint, number]>) {
    const spoken = Number(priceDecimalText(raw, decimals).replace(/,/g, ''));
    const actual = Number(raw) / 10 ** decimals;
    assert.ok(
      Math.abs(spoken - actual) <= actual * 1e-3,
      `${priceDecimalText(raw, decimals)} is not ${actual}: the written-out form has the wrong magnitude`,
    );
  }
});

test('the price component renders the written-out figure, and hides the folded one', () => {
  /*
   * Rule-52 reachability. `priceDecimalText` existing changes nothing until the
   * component uses it, and the second half matters just as much: leaving the folded
   * markup visible to the tree makes a reader hear both figures, the wrong one last.
   */
  const src = maskComments(
    readFileSync(join(import.meta.dirname, '..', 'components', 'Price.tsx'), 'utf8'),
  );

  assert.match(
    src,
    /priceDecimalText\(/,
    'the price component no longer builds a written-out figure, so the magnitude is ' +
      'carried only by markup a screen reader cannot see',
  );
  assert.match(
    src,
    /className="sr-only">\{spoken\}</,
    'the written-out figure is no longer in the accessibility tree',
  );
  assert.match(
    src,
    /<span aria-hidden="true">/,
    'the folded figure is no longer hidden from the accessibility tree, so the price ' +
      'is announced twice and the shorthand reading comes last',
  );
  assert.doesNotMatch(
    src,
    /<sub className="px-zeros" aria-hidden/,
    'the zero count is hidden on its own again, which is the original defect: it ' +
      'removes the magnitude and puts nothing in its place',
  );
});

test('a ticker always gets the same hue, within the wheel', () => {
  assert.equal(tickerHue('KAIJU'), tickerHue('kaiju'));
  for (const s of ['A', 'KAIJU', 'NOCTIS', 'ZZZZZZZZ']) {
    const h = tickerHue(s);
    assert.ok(h >= 0 && h < 360);
  }
  assert.notEqual(tickerHue('KAIJU'), tickerHue('NOCTIS'));
});
