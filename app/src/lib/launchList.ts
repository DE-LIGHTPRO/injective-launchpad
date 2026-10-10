import type { TokenProfile } from './tokenProfile.ts';
import type { LaunchRules } from './launchRules.ts';
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

/**
 * How a board can be ordered here.
 *
 * nearly.trade offers Market cap, New, Hot, Volume, Holders and Gainers. Three of
 * those are not available on this chain and are left out rather than approximated:
 *
 *   HOLDERS  `denom_owners` returns 501 for a factory denom. See `creatorHolding.ts`.
 *   VOLUME   Lifetime volume needs every trade ever recorded. It is a tx-log scan per
 *            launch, and Injective's query limits make that unreliable at board sizes.
 *            `raised` is the curve's current reserve, which is a different claim: it
 *            FALLS when people sell, where volume never would.
 *   GAINERS  A change needs two prices separated by a known time. Without a price
 *            history per launch there is no earlier price to compare against, and a
 *            "gainers" tab ordered by something else is worse than no tab.
 */
export type SortKey = 'marketCap' | 'progress' | 'raised' | 'newest';

export interface LaunchRow {
  id: number;
  denom: string;
  creator: string;
  /** Base units as a decimal string: bigints are not serialisable as props. */
  raised: string;
  target: string;
  progress: number;
  graduated: boolean;
  /** Already normalised by `parseProfile`; the values inside are still untrusted. */
  profile: TokenProfile;
  /** Needed for the status chip: a launch before its start time is not "live". */
  rules: LaunchRules;
  /**
   * The curve's own numbers, as decimal strings.
   *
   * Strings because a bigint cannot cross the server-component boundary: passing one
   * throws at render, and passing it as a Number silently loses the low digits at 18
   * decimals, which is the quieter failure and the worse one.
   */
  curve: {
    virtualInj: string;
    virtualTokens: string;
    curveSupply: string;
    graduationTarget: string;
    feeBps: string;
  };
  tokensSold: string;
  /** Spot price times total supply, base units as a string. The board's headline. */
  marketCap: string;
  /**
   * The curve CONTRACT address, which is a different thing from `curve` above: that
   * is the shape, this is where it lives. Named apart on purpose, because the board
   * needs the address to query a launch's activity and the two would otherwise be one
   * keystroke from each other.
   */
  curveAddress: string;
  /** Unix seconds the curve opened, or null when the contract predates the field. */
  openedAt: number | null;
  /** Fees accrued to creator and platform, base units. Feeds the totals bar. */
  feesAccrued: string;
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
    if (sel.sort === 'marketCap') {
      // Bigints, for the same reason `raised` compares as one: at 18 decimals a
      // Number comparison ties values that differ by real amounts.
      const x = BigInt(a.marketCap);
      const y = BigInt(b.marketCap);
      return x > y ? -1 : x < y ? 1 : 0;
    }
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
