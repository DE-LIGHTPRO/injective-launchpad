import test from 'node:test';
import assert from 'node:assert/strict';

import { priceParts, priceText, tickerHue } from './priceFormat.ts';

const E18 = 10n ** 18n;

test('a tiny price folds its zeros into a subscript', () => {
  // 0.0000002942 INJ, the demo launch's spot price.
  const raw = 294_200_000_000n; // 2.942e-7 at 18 decimals
  assert.deepEqual(priceParts(raw, 18), { lead: '0.0', zeros: 6, digits: '2942' });
  assert.equal(priceText(raw, 18), '0.0₆2942');
});

test('a price with few zeros is printed plainly', () => {
  assert.equal(priceText(12_340_000_000_000_000n, 18), '0.01234');
  assert.equal(priceText(1_200_000_000_000_000n, 18), '0.0012');
});

test('prices at or above one are grouped, not folded', () => {
  assert.equal(priceText(1234n * E18 + 5n * 10n ** 17n, 18), '1,234.5');
  assert.equal(priceText(2n * E18, 18), '2');
});

test('works at six decimals, as a USDC-priced launch needs', () => {
  assert.equal(priceText(3n, 6), '0.0₅3');
  assert.equal(priceText(300n, 6), '0.0003');
  assert.equal(priceText(1n, 9), '0.0₈1');
});

test('zero and negatives are zero, never a minus sign or NaN', () => {
  assert.equal(priceText(0n, 18), '0');
  assert.equal(priceText(-5n, 18), '0');
});

test('a ticker always gets the same hue, within the wheel', () => {
  assert.equal(tickerHue('KAIJU'), tickerHue('kaiju'));
  for (const s of ['A', 'KAIJU', 'NOCTIS', 'ZZZZZZZZ']) {
    const h = tickerHue(s);
    assert.ok(h >= 0 && h < 360);
  }
  assert.notEqual(tickerHue('KAIJU'), tickerHue('NOCTIS'));
});
