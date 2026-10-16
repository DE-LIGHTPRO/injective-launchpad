import { marketCapExact, type CurveConfig, type CurveState, type PoolReserves } from './curve.ts';

/**
 * The figures a launchpad board is read by, and the ones this chain cannot produce.
 *
 * Modelled on what nearly.trade shows per card, which is the mature version of this
 * surface: market cap as the headline, age, fee, progress, and activity counts. Two of
 * one of their columns is deliberately absent here rather than approximated:
 *
 *   HOLDERS   Measured and not available. `denom_owners` returns 501 for a factory
 *             denom on Injective and the explorer serves an HTML page rather than an
 *             API. It needs a self-hosted indexer. A guess in that column would be the
 *             single most misleading number on the page, because distribution is
 *             exactly what a buyer is trying to judge.
 *
 * PAIRED USED TO BE THE SECOND, on the grounds that every launch here quotes in INJ and
 * a filter offering one option is a control that does nothing. That stopped being true:
 * the factory's quote allowlist carries two assets on testnet (INJ at 18 decimals and
 * a 6-decimal E2EUSD), launches are split across both, and the board has rendered a
 * "Paired with" filter for a while. A documented limitation that has since been lifted
 * reads as a live constraint and steers the next person away from what already shipped,
 * which is why it is recorded as lifted rather than quietly deleted.
 */

const ONE = 10n ** 18n;

/**
 * Market cap: spot price times the whole supply.
 *
 * FULLY DILUTED, and that is the convention every launchpad uses, but it needs saying
 * because on a bonding curve it is a larger claim than it looks. The spot price is what
 * the curve would charge for the NEXT token, not a price anyone traded at scale, so
 * multiplying it by a supply that mostly has not been sold describes what the launch
 * would be worth if the curve ran to the end at today's price. Early on that figure is
 * dominated by tokens nobody has bought.
 *
 * Returned in quote base units. Converting to USD needs a price for the quote asset,
 * which is a separate measurement with its own provenance.
 */
export function marketCap(
  config: CurveConfig,
  state: CurveState,
  totalSupply: bigint,
  pool: PoolReserves | null = null,
): bigint {
  // From the reserves in one division. Going through a floored per-token price first
  // made every 6-decimal launch read 0: the price is below one USDC base unit.
  return marketCapExact(config, state, pool, totalSupply);
}

/**
 * How long ago, in the shortest form that is still true.
 *
 * `null` for an unknown time rather than "just now", which is what a zero timestamp
 * formats to and which would label every launch created before `opened_at` existed as
 * brand new: the most eye-catching thing a board can say, about the oldest launches on
 * it.
 */
export function ageLabel(openedAtSeconds: number | null, nowSeconds: number): string | null {
  if (openedAtSeconds === null || openedAtSeconds <= 0) return null;
  const secs = nowSeconds - openedAtSeconds;
  // A clock skew of a few seconds between a browser and a chain is ordinary and must
  // not render as a launch from the future.
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The fee badge, which is nearly.trade's "TAX 1/1" done honestly for this contract.
 *
 * Theirs shows a buy and a sell number because their tokens can tax each side
 * differently. This curve charges ONE fee on both sides, so showing "1/1" would imply a
 * pair of independently settable numbers that do not exist. It shows the single figure.
 *
 * The creator's share is not in the badge. It is a split of the fee rather than an
 * additional cost, so a buyer who reads "1%" has read the whole of what they pay, and
 * adding a second number here would read as two.
 */
export function feeLabel(feeBps: bigint): string {
  const pct = Number(feeBps) / 100;
  // Trailing zeros dropped: "1%" rather than "1.00%", because this is a badge.
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}% fee`;
}

export interface BoardTotals {
  launches: number;
  /** Quote raised across every live curve, in base units. */
  raised: bigint;
  /** Fees accrued to creators and the platform, in base units. */
  feesAccrued: bigint;
  /**
   * Lifetime quote actually handed to creators, in base units.
   *
   * A different claim from `feesAccrued`, which is only what is unclaimed at this
   * instant and DROPS when someone claims. This only rises. It is the figure a
   * creator weighs when choosing a launchpad, which is why nearly.trade runs
   * "$146.6K PAID TO CREATORS" on its homepage, and it is counted by the contract as
   * it pays rather than reconstructed from events.
   */
  paidToCreators: bigint;
  graduated: number;
}

/**
 * Platform totals, summed from the launches already fetched.
 *
 * No extra queries: every figure here comes from data the board has loaded anyway, so
 * the bar costs nothing and cannot be out of step with the cards beneath it. That
 * matters more than it sounds. A totals bar fed by its own endpoint is the classic
 * place for a page to contradict itself, and a visitor who adds up the cards and gets a
 * different number trusts neither figure afterwards.
 *
 * `raised` is what the curves currently hold, NOT lifetime volume. They are different
 * claims and the smaller one is the one that can be computed from state: a sell reduces
 * the reserve, so this falls when people exit, where volume never would. Labelled as
 * reserve for that reason, and volume is left out rather than approximated by it.
 */
export function boardTotals(
  rows: Array<{ raised: bigint; feesAccrued: bigint; graduated: boolean; creatorPaid: bigint }>,
): BoardTotals {
  return {
    launches: rows.length,
    raised: rows.reduce((a, r) => a + r.raised, 0n),
    feesAccrued: rows.reduce((a, r) => a + r.feesAccrued, 0n),
    paidToCreators: rows.reduce((a, r) => a + r.creatorPaid, 0n),
    graduated: rows.filter((r) => r.graduated).length,
  };
}

/** Compact money, so a board of them lines up: 1.2K, 3.4M. */
export function compact(raw: bigint, decimals = 18, maxFrac = 2): string {
  const whole = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(whole)) return '0';
  const abs = Math.abs(whole);
  if (abs >= 1_000_000) return `${(whole / 1_000_000).toFixed(maxFrac)}M`;
  if (abs >= 1_000) return `${(whole / 1_000).toFixed(maxFrac)}K`;
  /*
   * Below 1, more precision rather than less. A launch at 0.00 reads as a launch with
   * nothing in it, and on a board where most entries are small that is most of them.
   */
  if (abs > 0 && abs < 1) return whole.toFixed(4);
  return whole.toFixed(maxFrac);
}

