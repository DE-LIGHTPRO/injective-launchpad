import test from 'node:test';
import assert from 'node:assert/strict';
import {
  totalsByQuote,
  launchesPerDay,
  topCreators,
  graduationRate,
  type AnalyticsRow,
} from './analytics.ts';

const ONE = 10n ** 18n;
const SIX = 10n ** 6n;
const inj = { denom: 'inj', decimals: 18, label: 'INJ' };
const usdc = { denom: 'erc20:0xU', decimals: 6, label: '0xU…' };

const row = (p: Partial<AnalyticsRow> = {}): AnalyticsRow => ({
  quoteDenom: 'inj',
  quote: inj,
  graduated: false,
  raised: ONE,
  feesAccrued: 0n,
  creatorPaid: 0n,
  platformPaid: 0n,
  openedAt: null,
  creator: 'inj1a',
  ...p,
});

test('totals are grouped per quote, never summed across them', () => {
  /*
   * These are base units. 18-decimal INJ added to 6-decimal USDC is wrong by twelve
   * orders of magnitude, and there is no oracle here to convert with, so one row per
   * asset is the only honest shape.
   */
  const rows = [
    row({ raised: 2n * ONE, creatorPaid: ONE }),
    row({ quoteDenom: 'erc20:0xU', quote: usdc, raised: 5n * SIX, creatorPaid: SIX }),
  ];
  const t = totalsByQuote(rows);
  assert.equal(t.length, 2);
  const i = t.find((x) => x.quote.denom === 'inj')!;
  const u = t.find((x) => x.quote.denom === 'erc20:0xU')!;
  assert.equal(i.reserves, 2n * ONE);
  assert.equal(u.reserves, 5n * SIX);
  // The USDC row must not have been inflated to 18 decimals on the way in.
  assert.ok(u.reserves < ONE, 'a 6-decimal total was scaled as 18');
});

test('a launch with no opening time is dropped, not counted as new', () => {
  /*
   * The oldest launches are the likeliest to lack `opened_at`, so bucketing them into
   * today would draw a growth curve out of missing data: the chart would show a spike
   * of new launches made of the oldest ones on the board.
   */
  const now = 1_000_000_000;
  const DAY = 86_400;
  const rows = [
    row({ openedAt: now - 10 }),
    row({ openedAt: now - 2 * DAY - 10 }),
    row({ openedAt: null }),
    row({ openedAt: 0 }),
  ];
  const series = launchesPerDay(rows, now, 7);
  assert.equal(series.find((s) => s.day === 0)!.count, 1, 'today is wrong');
  assert.equal(series.find((s) => s.day === 2)!.count, 1, 'two days ago is wrong');
  assert.equal(series.reduce((a, s) => a + s.count, 0), 2, 'an undated launch was counted');
});

test('a launch older than the window is not folded into the oldest bucket', () => {
  const now = 1_000_000_000;
  const rows = [row({ openedAt: now - 86_400 * 40 })];
  const series = launchesPerDay(rows, now, 7);
  assert.equal(series.reduce((a, s) => a + s.count, 0), 0);
});

test('creators rank by launch count, not by fees across quotes', () => {
  // Adding a creator's INJ fees to their USDC fees to rank them produces a number
  // that is not an amount of anything.
  const rows = [
    row({ creator: 'inj1a' }),
    row({ creator: 'inj1a', graduated: true }),
    row({ creator: 'inj1b', quoteDenom: 'erc20:0xU', quote: usdc, creatorPaid: 999n * SIX }),
  ];
  const top = topCreators(rows);
  assert.equal(top[0].creator, 'inj1a');
  assert.equal(top[0].launches, 2);
  assert.equal(top[0].graduated, 1);
});

test('an empty board has no graduation rate rather than a rate of zero', () => {
  /*
   * "None of zero launches graduated" is not a 0% graduation rate, it is no rate at
   * all, and a headline reading 0% on a new launchpad says something false about it.
   */
  assert.equal(graduationRate([]), null);
  assert.equal(graduationRate([row(), row({ graduated: true })]), 0.5);
});
