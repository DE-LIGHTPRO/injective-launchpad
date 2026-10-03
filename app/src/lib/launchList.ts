import { symbolOf } from './chain.ts';

/**
 * Search, sort and filter for the launch index.
 *
 * EXTRACTED SO IT CAN BE TESTED ON DATA THAT DISCRIMINATES. It lived inside the
 * component, and driving the real page could not confirm it worked: the four demo
 * launches have ids 1 to 4 with volumes 3, 31, 68 and 140 against one shared
 * target, so the three sorts produce identical orders. Clicking each one and
 * seeing the same list is consistent with sorting working and with sorting being
 * broken, which makes it not a measurement.
 *
 * The tests below use rows where the three orders differ, so each assertion can
 * only pass for one of them.
 */

export type SortKey = 'progress' | 'raised' | 'newest';

export interface LaunchRow {
  id: number;
  denom: string;
  creator: string;
  /** Base units as a decimal string: bigints are not serialisable as props. */
  raised: string;
  target: string;
  progress: number;
  graduated: boolean;
}

export interface Selection {
  q: string;
  sort: SortKey;
  hideGraduated: boolean;
}

/**
 * Does this row answer to what was typed?
 *
 * Matched against the ticker, the full denom and the creator, because all three
 * are things somebody arrives already knowing. Searching the ticker alone fails
 * the person who followed a link and has a contract address.
 */
export function matches(row: LaunchRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    symbolOf(row.denom).toLowerCase().includes(needle) ||
    row.denom.toLowerCase().includes(needle) ||
    row.creator.toLowerCase().includes(needle)
  );
}

export function selectLaunches(rows: readonly LaunchRow[], sel: Selection): LaunchRow[] {
  const out = rows.filter((r) => {
    if (sel.hideGraduated && r.graduated) return false;
    return matches(r, sel.q);
  });

  return [...out].sort((a, b) => {
    if (sel.sort === 'newest') return b.id - a.id;
    if (sel.sort === 'raised') {
      /*
       * Compared as bigints. At 18 decimals a Number comparison starts tying
       * values that differ by real amounts: 2^53 is about 9e15, and one INJ is
       * 1e18 base units, so Number loses the low three digits of every balance
       * before any comparison happens.
       */
      const x = BigInt(a.raised);
      const y = BigInt(b.raised);
      return x > y ? -1 : x < y ? 1 : 0;
    }
    return b.progress - a.progress;
  });
}
