import type { Quote } from './chain.ts';

/**
 * What this launchpad can honestly say about itself.
 *
 * Both comparable launchpads run an analytics page and both can say things this one
 * cannot, because they have indexers. The discipline here is the same as everywhere
 * else in this codebase: every figure is derived from state the chain will actually
 * answer for, and the ones it will not are absent rather than estimated.
 *
 * ABSENT ON PURPOSE, with the reason, so nobody adds them later believing they were
 * forgotten:
 *
 *   LIFETIME VOLUME   Needs every trade ever. Injective's tx search pages, and a
 *                     board-wide scan is unbounded work that grows with the product.
 *                     "In curve reserves" is the figure state CAN answer, and it is a
 *                     different claim: a sell reduces it where volume never would.
 *   HOLDERS           `denom_owners` answers 501 Not Implemented for a tokenfactory
 *                     denom. Deriving it from trade history would be wrong rather
 *                     than approximate, because a bank send runs no contract code, so
 *                     transfers off the curve are invisible.
 *   USD ANYTHING      No price oracle. Every figure is in its own quote asset, which
 *                     is why these are grouped per quote rather than summed.
 */

export interface QuoteTotals {
  quote: Quote;
  launches: number;
  graduated: number;
  /** Quote the live curves currently hold. NOT volume. */
  reserves: bigint;
  /** Accrued and not yet claimed, both sides. */
  unclaimed: bigint;
  /** Lifetime, actually paid out to creators. */
  paidToCreators: bigint;
  /** Lifetime, actually paid out to the launchpad. */
  paidToPlatform: bigint;
}

export interface AnalyticsRow {
  quoteDenom: string;
  quote: Quote;
  graduated: boolean;
  raised: bigint;
  feesAccrued: bigint;
  creatorPaid: bigint;
  platformPaid: bigint;
  openedAt: number | null;
  creator: string;
}

/**
 * Totals per quote asset.
 *
 * GROUPED, NEVER SUMMED ACROSS QUOTES. These are base units, and 18-decimal INJ added
 * to 6-decimal USDC is wrong by twelve orders of magnitude. There is no oracle here
 * to convert with, so one row per asset is the only honest shape.
 */
export function totalsByQuote(rows: AnalyticsRow[]): QuoteTotals[] {
  const byQuote = new Map<string, QuoteTotals>();
  for (const r of rows) {
    const t = byQuote.get(r.quoteDenom) ?? {
      quote: r.quote,
      launches: 0,
      graduated: 0,
      reserves: 0n,
      unclaimed: 0n,
      paidToCreators: 0n,
      paidToPlatform: 0n,
    };
    t.launches += 1;
    if (r.graduated) t.graduated += 1;
    t.reserves += r.raised;
    t.unclaimed += r.feesAccrued;
    t.paidToCreators += r.creatorPaid;
    t.paidToPlatform += r.platformPaid;
    byQuote.set(r.quoteDenom, t);
  }
  // Busiest pair first, by launch count rather than by reserves: ranking pairs by a
  // sum of their own units would compare different assets to order them.
  return [...byQuote.values()].sort((a, b) => b.launches - a.launches);
}

/**
 * How many launches were created in each of the last `days` days.
 *
 * From `opened_at`, which the contract records, so this needs no indexer and no
 * scan. A launch whose opening time is unknown is EXCLUDED rather than bucketed into
 * today: the oldest launches are the ones most likely to lack it, and dropping them
 * into the newest bucket would draw a growth curve out of missing data.
 */
export function launchesPerDay(
  rows: AnalyticsRow[],
  nowSeconds: number,
  days = 14,
): Array<{ day: number; count: number }> {
  const out = Array.from({ length: days }, (_, i) => ({ day: days - 1 - i, count: 0 }));
  const DAY = 86_400;
  for (const r of rows) {
    if (r.openedAt === null || r.openedAt <= 0) continue;
    const age = Math.floor((nowSeconds - r.openedAt) / DAY);
    if (age < 0 || age >= days) continue;
    const slot = out.find((o) => o.day === age);
    if (slot) slot.count += 1;
  }
  return out;
}

/**
 * Creators ranked by how many launches they have made.
 *
 * BY COUNT, not by fees earned, and the reason is the usual one: fees are
 * denominated in each launch's quote, so adding a creator's INJ fees to their USDC
 * fees to rank them produces a number that is not an amount of anything.
 */
export function topCreators(
  rows: AnalyticsRow[],
  limit = 5,
): Array<{ creator: string; launches: number; graduated: number }> {
  const by = new Map<string, { creator: string; launches: number; graduated: number }>();
  for (const r of rows) {
    const c = by.get(r.creator) ?? { creator: r.creator, launches: 0, graduated: 0 };
    c.launches += 1;
    if (r.graduated) c.graduated += 1;
    by.set(r.creator, c);
  }
  return [...by.values()]
    .sort((a, b) => b.launches - a.launches || b.graduated - a.graduated)
    .slice(0, limit);
}

/**
 * Share of launches that have graduated.
 *
 * `null` for an empty board rather than 0%, because "none of zero launches
 * graduated" is not a 0% graduation rate, it is no rate at all, and a headline
 * reading 0% on a new launchpad says something false about it.
 */
export function graduationRate(rows: AnalyticsRow[]): number | null {
  if (rows.length === 0) return null;
  return rows.filter((r) => r.graduated).length / rows.length;
}
