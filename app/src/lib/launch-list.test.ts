import { EMPTY_PROFILE } from './tokenProfile.ts';
import { NO_RULES } from './launchRules.ts';
/**
 * Search, sort and filter for the launch index.
 *
 * WHY THESE ROWS LOOK AWKWARD. The four demo launches cannot test this. They have
 * ids 1 to 4 with volumes 3, 31, 68 and 140 against one shared target, so sorting
 * by progress, by amount raised and by newest all produce the same order. Driving
 * the real page, clicking each sort and seeing an identical list is consistent
 * with the sort working and with the sort doing nothing at all, so it is not a
 * measurement. These rows are built so each order is different from the other two,
 * and every assertion below can only pass for the one it names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLaunches, matches, type LaunchRow } from './launchList.ts';

const ONE = 10n ** 18n;

const row = (
  id: number,
  sym: string,
  raisedInj: bigint,
  progress: number,
  graduated = false,
  creator = `inj1creator${id}`,
): LaunchRow => ({
  id,
  denom: `factory/inj1pad/${sym}`,
  creator,
  // Selection has no opinion about identity, so the fixture carries none.
  profile: EMPTY_PROFILE,
  // Selection has no opinion about rules either; the status chip reads them, not this.
  rules: NO_RULES,
  raised: (raisedInj * ONE).toString(),
  target: (100n * ONE).toString(),
  progress,
  graduated,
});

/*
 * Deliberately crossed: the biggest raise is not the closest to graduating (it
 * has a different target in practice, modelled here by progress), and neither is
 * the newest. Each sort therefore has a unique correct answer.
 */
const ROWS: LaunchRow[] = [
  row(1, 'ALPHA', 90n, 0.30),
  row(2, 'BETA', 10n, 0.95),
  row(3, 'GAMMA', 50n, 0.60, true),
  row(4, 'DELTA', 5n, 0.10),
];

const syms = (rs: LaunchRow[]) => rs.map((r) => r.denom.split('/').pop());

test('the fixture can tell the three sorts apart', () => {
  // Asserted first, because if the fixture ever stops discriminating then every
  // test below passes without testing anything, which is the exact failure that
  // made the browser check worthless.
  const byProgress = syms(selectLaunches(ROWS, { q: '', sort: 'progress', hideGraduated: false }));
  const byRaised = syms(selectLaunches(ROWS, { q: '', sort: 'raised', hideGraduated: false }));
  const byNewest = syms(selectLaunches(ROWS, { q: '', sort: 'newest', hideGraduated: false }));
  assert.notDeepEqual(byProgress, byRaised, 'progress and raised give the same order');
  assert.notDeepEqual(byProgress, byNewest, 'progress and newest give the same order');
  assert.notDeepEqual(byRaised, byNewest, 'raised and newest give the same order');
});

test('closest to graduating is sorted by progress, highest first', () => {
  assert.deepEqual(
    syms(selectLaunches(ROWS, { q: '', sort: 'progress', hideGraduated: false })),
    ['BETA', 'GAMMA', 'ALPHA', 'DELTA'],
  );
});

test('most raised is sorted by amount, not by progress', () => {
  assert.deepEqual(
    syms(selectLaunches(ROWS, { q: '', sort: 'raised', hideGraduated: false })),
    ['ALPHA', 'GAMMA', 'BETA', 'DELTA'],
  );
});

test('newest is sorted by id, highest first', () => {
  assert.deepEqual(
    syms(selectLaunches(ROWS, { q: '', sort: 'newest', hideGraduated: false })),
    ['DELTA', 'GAMMA', 'BETA', 'ALPHA'],
  );
});

test('amounts are compared as integers, not as floats', () => {
  /*
   * One INJ is 1e18 base units and Number is exact only to about 9e15, so a
   * Number comparison loses the low three digits of every balance before it
   * compares anything. These two differ by one base unit and must still order.
   */
  const a = { ...row(1, 'A', 0n, 0.5), raised: (1_000n * ONE + 1n).toString() };
  const b = { ...row(2, 'B', 0n, 0.5), raised: (1_000n * ONE).toString() };
  assert.deepEqual(
    syms(selectLaunches([b, a], { q: '', sort: 'raised', hideGraduated: false })),
    ['A', 'B'],
  );
  // And the same comparison through Number would tie, which is the point.
  assert.equal(Number(a.raised) === Number(b.raised), true, 'premise changed: Number no longer ties');
});

test('sorting does not mutate what it was given', () => {
  // The rows come from a server component's props; sorting in place would reorder
  // the caller's array and make the next render depend on the last one.
  const before = syms(ROWS);
  selectLaunches(ROWS, { q: '', sort: 'raised', hideGraduated: false });
  assert.deepEqual(syms(ROWS), before);
});

test('search covers the ticker, the full denom and the creator', () => {
  // All three are things somebody arrives already knowing. Ticker alone fails the
  // person who followed a link and has an address.
  assert.deepEqual(syms(selectLaunches(ROWS, { q: 'beta', sort: 'newest', hideGraduated: false })), ['BETA']);
  assert.deepEqual(syms(selectLaunches(ROWS, { q: 'inj1pad/GAMMA', sort: 'newest', hideGraduated: false })), ['GAMMA']);
  assert.deepEqual(syms(selectLaunches(ROWS, { q: 'inj1creator4', sort: 'newest', hideGraduated: false })), ['DELTA']);
});

test('search ignores case and surrounding space', () => {
  for (const q of ['ALPHA', 'alpha', '  Alpha  ']) {
    assert.deepEqual(syms(selectLaunches(ROWS, { q, sort: 'newest', hideGraduated: false })), ['ALPHA'], q);
  }
});

test('an empty query matches everything rather than nothing', () => {
  // The inverse is a plausible bug and would render the page blank on load.
  assert.equal(selectLaunches(ROWS, { q: '   ', sort: 'newest', hideGraduated: false }).length, ROWS.length);
  assert.equal(matches(ROWS[0], ''), true);
});

test('a query matching nothing returns nothing, and is not a silent reset', () => {
  // Falling back to the full list would read as a broken filter rather than as no
  // results, and the caller could not tell the two apart.
  assert.equal(selectLaunches(ROWS, { q: 'zzzznope', sort: 'newest', hideGraduated: false }).length, 0);
});

test('hiding graduated removes only the graduated', () => {
  const shown = selectLaunches(ROWS, { q: '', sort: 'newest', hideGraduated: true });
  assert.deepEqual(syms(shown), ['DELTA', 'BETA', 'ALPHA']);
  assert.ok(shown.every((r) => !r.graduated));
});

test('the filter and the search compose rather than override', () => {
  // GAMMA matches the search and is graduated, so with the filter on the result is
  // empty. An implementation applying only the last condition would return it.
  assert.equal(
    selectLaunches(ROWS, { q: 'gamma', sort: 'newest', hideGraduated: true }).length,
    0,
  );
  assert.equal(
    selectLaunches(ROWS, { q: 'gamma', sort: 'newest', hideGraduated: false }).length,
    1,
  );
});
