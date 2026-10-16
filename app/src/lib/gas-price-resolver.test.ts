/**
 * One gas price, in one place, because there were two literals for one decision.
 *
 * `broadcast.ts` built every fee as `BigInt(opts.gas) * 500_000_000n`, and `wallet.ts`
 * separately handed Keplr `gasPriceStep: { low: 500000000, average: 700000000, high:
 * 900000000 }` in the chain definition it suggests to an extension that does not
 * already know Injective. Nothing connected the two numbers.
 *
 * WHY THAT MATTERS IN ONE DIRECTION MORE THAN THE OTHER. A Keplr `low` BELOW what the
 * app sends shows the user a cheaper fee than the transaction actually carries, which
 * is a disclosure defect on a signing screen. And this is a number with a standing
 * reason to be edited: `broadcast.ts`'s comment called 500000000 "the minimum", which
 * it is not, so the obvious correction was to move it DOWN to the real floor. Whoever
 * made that correction would have found one of the two copies.
 *
 * THE PREMISE WAS MEASURED RATHER THAN ASSUMED, because "it is the minimum" was the
 * claim in the source and it was false. `/cosmos/base/node/v1beta1/config`, 16 Oct 2026:
 *
 *     sentry.lcd.injective.network          minimum_gas_price 160000000...inj
 *     testnet.sentry.lcd.injective.network  minimum_gas_price 160000000...inj
 *
 * Both chains, the same floor, and 500000000 is a deliberate 3.1x margin over it. The
 * margin is the right call - the floor is per node, a validator may set a higher one,
 * and the whole difference on a 3,000,000-gas launch is 0.0015 INJ against 0.00048 -
 * but it is a choice, and a choice has to be written down or it gets "fixed".
 *
 * These assertions are deliberately BOTH value and source. The value test pins that
 * the refactor changed nothing a wallet is told; the source test pins that a third
 * copy cannot be added later, which is the failure that actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GAS_PRICE_INJ } from './config.ts';

const LIB = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(LIB, f), 'utf8');

/** Comment ranges masked, so prose explaining a number is not read as using one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

test('the gas price is the measured floor plus a margin, not the floor', () => {
  /*
   * ANTI-VACUITY, and the whole reason the constant carries a docblock. If this ever
   * equals 160000000 somebody has "corrected" it to the chain minimum, which is
   * exactly the edit the old "500000000 is the minimum" comment invited. A fee at the
   * floor is refused by any node that has set a higher one, and the transaction that
   * gets refused is a launch the creator has already paid the denom fee for.
   */
  const FLOOR = 160_000_000n; // measured on both chains, 16 Oct 2026
  assert.notEqual(GAS_PRICE_INJ, FLOOR, 'the gas price was reduced to the chain minimum, leaving no margin');
  assert.ok(GAS_PRICE_INJ > FLOOR, `${GAS_PRICE_INJ} is below the measured minimum gas price ${FLOOR}`);
  assert.ok(
    GAS_PRICE_INJ <= FLOOR * 10n,
    `${GAS_PRICE_INJ} is more than 10x the floor; a margin that large is probably a typo`,
  );
});

test('what Keplr is told is what the app actually pays', () => {
  /*
   * The direction that matters: `low` is the figure the extension shows for a
   * transaction it prices itself, and it must not undercut the fee this app sets.
   * Asserting equality rather than `>=` because they are the same decision - a `low`
   * ABOVE our price would be its own small lie.
   */
  const src = read('wallet.ts');
  const step = src.match(/gasPriceStep:\s*\{([\s\S]*?)\}/);
  assert.ok(step, 'wallet.ts no longer suggests a gasPriceStep to Keplr');
  assert.match(step[1], /low:\s*Number\(GAS_PRICE_INJ\)/, 'Keplr is told a gas price the app does not pay');

  // And the presets stay proportional, which is what makes one edit carry all three.
  assert.match(step[1], /average:[^,]*GAS_PRICE_INJ/, 'the average preset is no longer derived');
  assert.match(step[1], /high:[^,]*GAS_PRICE_INJ/, 'the high preset is no longer derived');
});

test('the refactor changed no number a wallet or a validator sees', () => {
  /*
   * The three values Keplr was given before the constant existed. A refactor that
   * quietly moved any of them would be a worse bug than the duplication it fixed.
   */
  assert.equal(Number(GAS_PRICE_INJ), 500_000_000);
  assert.equal(Number((GAS_PRICE_INJ * 14n) / 10n), 700_000_000);
  assert.equal(Number((GAS_PRICE_INJ * 18n) / 10n), 900_000_000);

  // And the fee a 3,000,000-gas launch carries, which is the figure in the docblock.
  assert.equal(3_000_000n * GAS_PRICE_INJ, 1_500_000_000_000_000n); // 0.0015 INJ
});

test('no module spells the gas price for itself', () => {
  /*
   * THE GUARD THAT CATCHES THE RECURRENCE. A third copy is how this started: each
   * site was locally correct and no test looked across them. Matching the literal
   * rather than a general "big number" pattern, because this specific value is the
   * one with two homes - and matching it in `wallet.ts` and `broadcast.ts` by name,
   * because those are the two that had it.
   *
   * Comments are masked: the docblocks deliberately quote 500000000 while explaining
   * why it is not the minimum, and a guard that forbade naming the number in prose
   * would forbid the explanation.
   */
  for (const file of ['wallet.ts', 'broadcast.ts']) {
    const src = stripComments(read(file));
    /*
     * `n?` IS LOAD-BEARING, and it took a mutation to find out. Written without it
     * the pattern was `/\b500_?000_?000\b/`, which cannot match `500_000_000n`: the
     * bigint suffix is a word character, so there is no word boundary after the last
     * digit. Restoring the literal in `broadcast.ts` - a bigint context, where the
     * `n` is mandatory - passed every assertion. The one file that reintroducing the
     * number is most likely in was the one file the guard could not see it in.
     */
    assert.doesNotMatch(
      src,
      /\b500_?000_?000n?\b/,
      `${file} restates the gas price instead of importing GAS_PRICE_INJ from config.ts`,
    );
    assert.match(src, /GAS_PRICE_INJ/, `${file} no longer reads the shared gas price at all`);
  }

  // The constant has exactly one definition, and it is in config.ts.
  const config = stripComments(read('config.ts'));
  assert.match(config, /export const GAS_PRICE_INJ = 500_000_000n;/, 'the gas price moved or changed shape');
});
