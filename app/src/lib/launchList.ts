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
export type SortKey = 'marketCap' | 'progress' | 'raised' | 'newest' | 'trades' | 'volume';

/**
 * Activity a row can be sorted by, when it has been read.
 *
 * SEPARATE FROM `LaunchRow` on purpose. A row is server-rendered and these numbers
 * are not: they arrive after the board paints, from a different source, at a
 * different time. Folding them into the row would make a field that is sometimes
 * absent for reasons the row itself cannot explain, and every consumer would have to
 * know which fields those were. Passing them beside it keeps "what the chain said
 * about this launch" and "what we have managed to measure so far" apart.
 */
export interface ActivityIndex {
  [curveAddress: string]: { trades: number | null; volume24h: bigint | null } | undefined;
}

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
  /**
   * What this launch is priced in, and the decimals of it.
   *
   * CARRIED PER ROW, not read from the network config, and that distinction is the
   * whole reason multi-quote is safe on this board. Every figure on a card, market
   * cap, reserve, volume, is denominated in THIS launch's quote: a card showed
   * `NETWORK.quoteSymbol` from a constant, so a USDC-paired launch rendered its
   * amounts labelled INJ, which is not an approximation, it is a different number
   * wearing the wrong name.
   */
  quoteDenom: string;
  quoteDecimals: number;
  /** The quote's display label (factory symbol, else a short denom). Optional for old callers. */
  quoteLabel?: string;
  /** Unix seconds the curve opened, or null when the contract predates the field. */
  openedAt: number | null;
  /** Fees accrued to creator and platform, base units. Feeds the totals bar. */
  feesAccrued: string;
}

export interface Selection {
  /**
   * Show only launches priced in this quote, or `null` for all of them.
   *
   * Filtering is what keeps the board's arithmetic honest rather than being a
   * convenience. Totals sum base units and a market-cap sort compares them, and
   * neither is meaningful across quotes: 18-decimal INJ added to 6-decimal USDC is
   * wrong by twelve orders of magnitude, and there is no price oracle here to convert
   * with. So the board shows one quote at a time by default.
   */
  quote?: string | null;
  q: string;
  sort: SortKey;
  hideGraduated: boolean;
  /**
   * Which stage of its life a launch is in, like pump.fun's "newly created / about to
   * graduate / graduated" tabs. `undefined` or 'all' shows every stage.
   *
   *   live       on the curve, not yet graduated
   *   soon       on the curve and close to the target (about to graduate)
   *   graduated  the curve filled and the locked pool is live
   *
   * Kept separate from `hideGraduated`, which older callers still pass; when both are
   * given, graduated rows are hidden unless `status` is 'graduated', which asked for them.
   */
  status?: LaunchStatus;
}

export type LaunchStatus = 'all' | 'live' | 'soon' | 'graduated';

/**
 * Share of the target raised at which a launch counts as "about to graduate".
 *
 * 80%, not a rounder number by accident: the last fifth of a one-sided curve is where
 * price moves fastest and a graduating buy becomes likely, so it is the band a trader
 * watching for the pool opening actually wants. A lower bar would fill the tab with
 * launches that are not close; a higher one would hide them until it is too late to act.
 */
export const ABOUT_TO_GRADUATE = 0.8;

export function matchesStatus(row: LaunchRow, status: LaunchStatus | undefined): boolean {
  switch (status) {
    case 'graduated':
      return row.graduated;
    case 'live':
      return !row.graduated;
    case 'soon':
      return !row.graduated && row.progress >= ABOUT_TO_GRADUATE;
    default:
      return true;
  }
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

export function selectLaunches(
  rows: readonly LaunchRow[],
  sel: Selection,
  activity: ActivityIndex = {},
): LaunchRow[] {
  const out = rows.filter((r) => {
    if (!matchesStatus(r, sel.status)) return false;
    // `hideGraduated` still honoured for old callers, but an explicit 'graduated' tab
    // has asked for exactly those rows, so it wins.
    if (sel.hideGraduated && sel.status !== 'graduated' && r.graduated) return false;
    if (sel.quote != null && r.quoteDenom !== sel.quote) return false;
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
    /*
     * Activity sorts, which differ from the others in one way that matters: the
     * numbers may not have arrived. A launch whose activity is unread sorts LAST,
     * in its existing relative order, rather than being treated as zero.
     *
     * Zero would be a claim. On a board where most launches genuinely have no trades
     * yet, "unread" and "untraded" would be indistinguishable, and the unread ones
     * would be scattered through the zeros as though they had been measured.
     */
    if (sel.sort === 'trades' || sel.sort === 'volume') {
      const x = activity[a.curveAddress];
      const y = activity[b.curveAddress];
      const xv = sel.sort === 'trades' ? (x?.trades ?? null) : (x?.volume24h ?? null);
      const yv = sel.sort === 'trades' ? (y?.trades ?? null) : (y?.volume24h ?? null);
      if (xv === null && yv === null) return 0;
      if (xv === null) return 1;
      if (yv === null) return -1;
      // Volume is bigint and trades is number; both compare correctly this way, and
      // neither is converted, so an 18-decimal volume keeps its low digits.
      return xv > yv ? -1 : xv < yv ? 1 : 0;
    }

    return b.progress - a.progress;
  });
}
