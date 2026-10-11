import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClaimable, type ClaimRow } from './claimable.ts';

const ONE = 10n ** 18n;
const SIX = 10n ** 6n;
const row = (p: Partial<ClaimRow> = {}): ClaimRow => ({
  id: 1, curve: 'inj1c1', symbol: 'AAA', creator: 'inj1me', owed: ONE, quoteDenom: 'inj', ...p,
});

test('only the connected wallet’s launches are claimable', () => {
  const rows = [row({ id: 1 }), row({ id: 2, creator: 'inj1other' })];
  assert.deepEqual(selectClaimable(rows, 'inj1me').mine.map((r) => r.id), [1]);
});

test('no wallet means nothing, not everything', () => {
  /*
   * The dangerous default. A filter that falls through when the address is absent
   * would show every creator's balance to anyone who opened the page.
   */
  const s = selectClaimable([row(), row({ creator: 'inj1other' })], null);
  assert.deepEqual(s.mine, []);
  assert.deepEqual(s.withFees, []);
});

test('launches with nothing owed are kept but not claimed', () => {
  /*
   * Both lists matter. `mine` drives the "nothing owed yet" line, which stops a
   * creator wondering whether a launch was missed; `withFees` drives the button, so
   * the transaction carries no pointless messages.
   */
  const s = selectClaimable([row({ id: 1, owed: 0n }), row({ id: 2, owed: ONE })], 'inj1me');
  assert.deepEqual(s.mine.map((r) => r.id), [1, 2]);
  assert.deepEqual(s.withFees.map((r) => r.id), [2]);
});

test('totals are per quote, never one number', () => {
  // Adding 18-decimal INJ to 6-decimal USDC is wrong by twelve orders of magnitude,
  // and there is no oracle here to convert with.
  const s = selectClaimable(
    [row({ owed: 2n * ONE }), row({ id: 2, owed: 3n * SIX, quoteDenom: 'erc20:0xU' })],
    'inj1me',
  );
  assert.equal(s.totals.length, 2);
  assert.equal(s.totals.find((t) => t.quoteDenom === 'inj')!.owed, 2n * ONE);
  assert.equal(s.totals.find((t) => t.quoteDenom === 'erc20:0xU')!.owed, 3n * SIX);
});

test('an address differing only in case is not a match', () => {
  /*
   * Bech32 is lowercase by construction, so a case-insensitive match could only ever
   * paper over an address mangled upstream, and showing somebody another wallet's
   * claimable fees is the worst way to discover that.
   */
  assert.deepEqual(selectClaimable([row({ creator: 'INJ1ME' })], 'inj1me').mine, []);
});
