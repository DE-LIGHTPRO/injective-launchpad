/**
 * The launch limits the factory contract enforces, mirrored for the form.
 *
 * WHY A MIRROR AT ALL. These numbers have to be in the browser: a form that lets a
 * creator fill in a supply the contract will refuse wastes a signature and a fee, and
 * tells them nothing until the chain rejects it. But a mirror is a second copy of a
 * fact, which is how a UI and a contract come to disagree quietly, so
 * `launch-limits.test.ts` reads the Rust source and fails if either value drifts.
 *
 * The contract is the authority in both cases. Nothing here relaxes anything: the form
 * refuses early and the factory refuses again.
 */

/**
 * Every launch has exactly one billion tokens, at 18 decimals.
 *
 * Fixed rather than chosen, because it is the number that makes every other number on
 * the board comparable. "Market cap" and "1 INJ buys N tokens" only mean something
 * across launches if the denominator is the same, and a creator who picks 10M instead
 * of 1B gets a token priced a hundred times higher per unit with nothing on its card
 * looking unusual.
 *
 * Mirrors `FIXED_TOTAL_SUPPLY` in `contracts/factory/src/lib.rs`.
 */
export const FIXED_TOTAL_SUPPLY = 1_000_000_000_000_000_000_000_000_000n;

/** The same figure in whole tokens, for copy that should not print 27 digits. */
export const FIXED_TOTAL_SUPPLY_TOKENS = 1_000_000_000;

/**
 * The creator's share of every trading fee, in bps of the fee. The rest is ours.
 *
 * Fixed, not chosen. Measured 10 Oct 2026 on nearly.trade/launch, which states it on
 * the form itself: "1B supply. 70% of the 1% pool fee is yours", beside "RHEA POOL ·
 * 1% FEE". ponsfamily.com splits "protocol / creator / buyback" from a policy
 * contract snapshotted per launch. Neither lets a creator set the number, and both
 * land on 70% to the creator.
 *
 * Mirrors `CREATOR_FEE_SHARE_BPS` in `contracts/factory/src/lib.rs`.
 */
export const CREATOR_FEE_SHARE_BPS = 7_000;

/** The platform's share, derived rather than written twice. */
export const PLATFORM_FEE_SHARE_BPS = 10_000 - CREATOR_FEE_SHARE_BPS;

/**
 * How a trading fee divides.
 *
 * Integer arithmetic, rounding the creator's side DOWN, which is what `split_fee` does
 * on chain: the odd base unit lands with the platform rather than being conjured. A
 * float here would show a creator a figure a base unit off what they actually get,
 * which is the kind of small disagreement that reads as the panel being wrong about
 * everything.
 */
export function splitFee(fee: bigint): { creator: bigint; platform: bigint } {
  const creator = (fee * BigInt(CREATOR_FEE_SHARE_BPS)) / 10_000n;
  return { creator, platform: fee - creator };
}

/**
 * The most of the CURVE's supply a creator may take in their own opening buy, in bps.
 *
 * Mirrors `MAX_INITIAL_BUY_BPS` in `contracts/factory/src/lib.rs`, where the reasoning
 * for 10% rather than nearly.trade's 4% is recorded: measured on this curve, 4% of
 * supply costs under 1 INJ, so their figure would refuse almost every real opening buy.
 */
export const MAX_INITIAL_BUY_BPS = 1_000;

/**
 * Token ceiling on an opening buy, for a given curve supply.
 *
 * AGAINST `curveSupply`, NOT the total, and the distinction is the whole reason this
 * function exists. The form shows the creator's share of the TOTAL supply, because
 * that is what a holder cares about and what the launch page publishes. The contract
 * caps against the curve supply, because that is what is actually purchasable. With
 * the default 80/20 split those differ by a quarter, so a form checking its own
 * displayed percentage against the contract's limit would let a creator through at
 * 10% of total, which is 12.5% of the curve, and the chain would refuse it after they
 * signed.
 *
 * Rounds down, matching `multiply_ratio` on chain, so the client's ceiling is never
 * above the contract's.
 */
export function initialBuyCeiling(curveSupply: bigint): bigint {
  return (curveSupply * BigInt(MAX_INITIAL_BUY_BPS)) / 10_000n;
}
