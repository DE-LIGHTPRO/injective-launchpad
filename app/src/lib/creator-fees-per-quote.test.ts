/**
 * A creator's two money figures were a dot, and the money was on the chain.
 *
 * THE DEFECT THIS EXISTS FOR. `/creator/[address]` summed its launches through
 * `boardTotals` and rendered one "Fees paid out" and one "Fees unclaimed", with
 *
 *   const one = quotes.size === 1 ? mine[0] : null;
 *
 * falling back to a bare `·` whenever a creator's launches did not all share a quote.
 * The reasoning behind that guard was right - 18-decimal INJ added to 6-decimal
 * E2EUSD is wrong by twelve orders of magnitude and there is no oracle here to convert
 * with - but withholding is not the remedy for unsummable, and the page said nothing
 * about why. The only note under those stats talks about generated names.
 *
 * Measured on live testnet, 16 Oct 2026: the factory's quote allowlist carries INJ and
 * a 6-decimal E2EUSD, the one creator on the chain has four launches split two and
 * two, and `creator_paid` across the two E2EUSD curves is 52333 + 173766586 base units
 * = 173.818919 E2EUSD. So the screen was showing a creator a dot where the chain said
 * it had paid them 173.8189, which on a page whose whole purpose is a creator's track
 * record is the worst figure to withhold.
 *
 * WHY THIS PAGE AND NOT THE OTHERS. `/analytics` groups per quote under "Grouped,
 * never summed", the home page's `heroStats` names the scope when it narrows to the
 * dominant quote, and `Portfolio` keeps "Totals are per quote, never summed across
 * them". Three screens had already chosen the shape; this one was the straggler, and a
 * lone `·` looks like a design decision rather than an omission.
 *
 * `boardRows.Row` gained `platformPaid` for this, because `totalsByQuote` takes both
 * sides of the fee. Passing `0n` for the half the creator page does not render would
 * have put an unmeasured zero into a shared aggregator to save reading a field that
 * `getLaunchDetail` already returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { totalsByQuote } from './analytics.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const CREATOR = join(SRC, 'app', 'creator', '[address]', 'page.tsx');

const code = (abs: string) => maskComments(readFileSync(abs, 'utf8'));

test('the creator page groups its fees per quote rather than summing them', () => {
  const page = code(CREATOR);
  assert.match(
    page,
    /totalsByQuote\(/,
    'the creator page no longer groups per quote; its figures span assets with different decimals',
  );
  assert.doesNotMatch(
    page,
    /boardTotals\(/,
    'the creator page sums across quotes again. `boardTotals` adds base units, and this ' +
      "page's rows can be a creator's INJ launches beside their 6-decimal ones",
  );
});

test('no figure on the creator page is withheld behind a no-value glyph', () => {
  /*
   * The placeholder itself is legitimate elsewhere - the board uses `·` for a metric
   * that genuinely has no value yet, such as a 24h volume nothing has traded. What
   * cannot be right is standing it in for a number already loaded, which is what the
   * ternary above did, because a reader cannot tell the two apart.
   */
  const page = code(CREATOR);
  // Escaped, not typed: the glyphs are written \u00b7 and \u2014 because
  // `no-em-dashes.test.ts` reads every source file and a literal one here is a finding
  // in its own right - which is how that guard caught this line's first draft.
  const offenders = [...page.matchAll(/['"`][\u00b7\u2014-]['"`]/g)].map(
    (m) => `${page.slice(0, m.index).split('\n').length}: ${m[0]}`,
  );
  assert.deepEqual(
    offenders,
    [],
    'a bare placeholder glyph is back on the creator page. Every figure this screen ' +
      'shows is derived from rows it has already loaded, so there is nothing for one to ' +
      `stand in for.\n  ${offenders.join('\n  ')}`,
  );
});

test('every amount on the creator page carries the asset it is an amount of', () => {
  /*
   * Grouping is only half of it. A figure correctly scoped to one quote and rendered
   * without naming it reads as the creator's total, which is the claim the grouping
   * exists to avoid making.
   */
  const page = code(CREATOR);
  const calls = [...page.matchAll(/compact\([^)]*\)/g)];
  assert.ok(calls.length >= 2, 'the creator page no longer renders any amount at all');
  for (const m of calls) {
    assert.match(
      m[0],
      /q\.quote\.decimals/,
      `${m[0]} scales an amount with something other than its own quote's decimals`,
    );
    assert.match(
      page.slice(m.index!, m.index! + m[0].length + 80),
      /q\.quote\.label/,
      `${m[0]} renders an amount with no asset named beside it`,
    );
  }
});

test("the launchpad's own paid-out total is read from the chain, not defaulted", () => {
  const rows = code(join(SRC, 'lib', 'boardRows.ts'));
  assert.match(
    rows,
    /platformPaid: d\.platformPaid/,
    'boardRows no longer carries the platform side of the fee, so the creator page has ' +
      'to invent one to call totalsByQuote',
  );
  assert.doesNotMatch(
    code(CREATOR),
    /platformPaid: 0n/,
    'the creator page feeds an unmeasured zero into a shared aggregator. Read the field ' +
      'through boardRows instead',
  );
});

test('summing these rows really would be wrong, so the grouping is not ceremony', () => {
  /*
   * Anti-vacuity, with the live shape: two 6-decimal launches and two 18-decimal ones
   * for one creator. If the two groups were ever comparable, everything above would be
   * protecting a distinction that does not exist.
   */
  const row = (denom: string, decimals: number, paid: bigint, graduated = false) => ({
    quoteDenom: denom,
    quote: { denom, decimals, label: denom.toUpperCase() },
    graduated,
    raised: 0n,
    feesAccrued: 0n,
    creatorPaid: paid,
    platformPaid: 0n,
    openedAt: null,
    creator: 'inj1creator',
  });

  const grouped = totalsByQuote([
    row('e2eusd', 6, 52_333n),
    row('e2eusd', 6, 173_766_586n, true),
    row('inj', 18, 0n),
    row('inj', 18, 0n),
  ]);

  assert.equal(grouped.length, 2, 'two quotes did not produce two groups');
  const usd = grouped.find((g) => g.quote.denom === 'e2eusd')!;
  const inj = grouped.find((g) => g.quote.denom === 'inj')!;
  assert.equal(usd.paidToCreators, 173_818_919n, 'the 6-decimal group is not the measured total');
  assert.equal(inj.paidToCreators, 0n, 'the 18-decimal group picked up the other quote');
  assert.equal(usd.graduated, 1, 'graduations are attributed to the wrong pair');

  /*
   * And the figure the old page would have shown. Summed, 173818919 base units read
   * against INJ's 18 decimals is 0.000000000173818919, which is not a small version of
   * the truth: it is a different quantity, and it rendered as a rounded zero.
   */
  const summed = usd.paidToCreators + inj.paidToCreators;
  assert.equal(
    Number(summed) / 1e18 < 0.000_1,
    true,
    'the cross-quote sum no longer disappears against 18 decimals; re-check whether the ' +
      'two quotes have become comparable',
  );
});
