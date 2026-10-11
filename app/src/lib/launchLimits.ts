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

/**
 * The curve every launch gets. Shape is policy; only the fee on it is chosen.
 *
 * Mirrors the `CURVE_*` constants in `contracts/factory/src/lib.rs`, where the
 * reasoning lives: fixing the supply alone did not make the board comparable, because
 * market cap is the spot price times the supply and the price came from a curve the
 * creator shaped. nearly.trade does the same and says so on their form: "Every launch
 * opens at the same price."
 */
export const FIXED_CURVE = {
  virtualInj: 60_000_000_000_000_000_000n,
  virtualTokens: 1_073_000_000_000_000_000_000_000_000n,
  curveSupply: 800_000_000_000_000_000_000_000_000n,
  graduationTarget: 170_000_000_000_000_000_000n,
} as const;

/**
 * The fixed curve in a quote asset's own units, exactly as the factory's `fixed_curve`
 * builds it: the two QUOTE figures (opening reserve, graduation target) are whole units
 * times 10^decimals; the token figures do not change. `FIXED_CURVE` is the 18-decimal
 * (INJ) case. Using it for a 6-decimal pair drew a curve, and parsed an opening buy,
 * a trillion times too large.
 */
export function fixedCurveFor(quoteDecimals: number) {
  const unit = 10n ** BigInt(quoteDecimals);
  return {
    ...FIXED_CURVE,
    virtualInj: BigInt(OPENING_RESERVE_QUOTE) * unit,
    graduationTarget: BigInt(GRADUATION_TARGET_QUOTE) * unit,
  };
}

/** The reserve held back for the pool: whatever the fixed supply leaves over. */
export const FIXED_LP_RESERVE = FIXED_TOTAL_SUPPLY - FIXED_CURVE.curveSupply;

/** Whole-token and whole-quote forms, for copy that should not print 27 digits. */
export const CURVE_SUPPLY_TOKENS = 800_000_000;
export const LP_RESERVE_TOKENS = 200_000_000;
export const OPENING_RESERVE_QUOTE = 60;
export const GRADUATION_TARGET_QUOTE = 170;

/**
 * The most a launch may charge per side, in bps.
 *
 * Mirrors `MAX_FEE_BPS` in `contracts/factory/src/lib.rs`. 10%, applied to the buy
 * fee and the sell fee independently.
 */
export const MAX_FEE_BPS = 1_000;

/**
 * What the create form starts a launch's fee at, per side, in bps.
 *
 * Here rather than inline in the form because the homepage hero quotes a trade on
 * the default launch, so the two have to agree or the hero prices a launch nobody
 * gets. The same duplication, in the curve's own shape, is what made that hero
 * advertise an 88 INJ graduation after the curve moved to 170.
 */
export const DEFAULT_FEE_BPS = 100;

/** Where the creator's share of each fee goes. Mirrors the contract's enum. */
export type RewardRoute = 'creator' | 'pool';

/**
 * The route as the contract spells it.
 *
 * `cw_serde` renders a unit variant as a lowercase string, so `creator` and `pool`
 * cross the wire exactly as typed here. Getting the casing wrong is refused as an
 * unknown variant rather than silently defaulting, which is the good failure.
 */
export const REWARD_ROUTES: Array<{ value: RewardRoute; label: string; detail: string }> = [
  {
    value: 'creator',
    label: 'To you',
    detail: 'Your 70% accrues on the launch and you claim it whenever you like.',
  },
  {
    value: 'pool',
    label: 'To the pool',
    detail:
      'Your 70% is held back and paired into the liquidity at graduation, deepening the market everyone trades in. You keep nothing from the fee.',
  },
];
