/**
 * The launch limits the factory contract enforces, mirrored for the form.
 *
 * WHY A MIRROR AT ALL. These numbers have to be in the browser: a form that lets a
 * creator fill in a supply the contract will refuse wastes a signature and a fee, and
 * tells them nothing until the chain rejects it. But a mirror is a second copy of a
 * fact, which is how a UI and a contract come to disagree quietly, so every value below
 * that says "mirrors X" is read out of the Rust and compared by a test.
 *
 * WHERE, because this docblock named `launch-limits.test.ts` and no such file has ever
 * existed - a pointer at nothing, which reads exactly like a pointer at a guard, and six
 * of the ten mirrored figures turned out to be pinned nowhere at all:
 *
 *   - `contract-mirror.test.ts`     the curve shape, the graduation ratio, the opening
 *                                   reserve, both string ceilings, and `fixedCurveFor`'s
 *                                   scaling
 *   - `execution-wiring.test.ts`    `CREATOR_FEE_SHARE_BPS`, `FIXED_TOTAL_SUPPLY`,
 *                                   `MAX_INITIAL_BUY_BPS`
 *   - `fee-ceiling-claims.test.ts`  `MAX_FEE_BPS`, against the factory and the math crate
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

/*
 * `splitFee` LIVED HERE AND NOTHING CALLED IT. It mirrored the contract's `split_fee`
 * carefully, down to rounding the creator's side so the odd base unit lands with the
 * platform - and the two figures it computed are read straight off the chain as
 * `creatorOwed` and `platformOwed`, which is the only honest source for money somebody
 * is about to claim. A client that re-derives an owed amount can disagree with the
 * balance that actually pays out.
 */

/**
 * The most of the CURVE's supply a creator may take in their own opening buy, in bps.
 *
 * Mirrors `MAX_INITIAL_BUY_BPS` in `contracts/factory/src/lib.rs`, where the reasoning
 * for 10% rather than nearly.trade's 4% is recorded along with the cost of both, at both
 * denominators.
 *
 * This used to say 4% of supply "costs under 1 INJ, so their figure would refuse almost
 * every real opening buy". Measured on 18 Oct 2026 it costs **20.989 INJ**, which is a
 * substantial opening buy rather than a negligible one, so the sentence argued the
 * opposite of what it claimed. The reason to prefer 10% is the one the Rust comment
 * gives - a controlling share is the thing worth refusing, and their 4% is a property of
 * their curve, not ours - and it never rested on this figure.
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
  virtualInj: 676_000_000_000_000_000_000n,
  virtualTokens: 1_073_000_000_000_000_000_000_000_000n,
  curveSupply: 800_000_000_000_000_000_000_000_000n,
  graduationTarget: 1_915_000_000_000_000_000_000n,
} as const;

/**
 * The fixed curve in a quote asset's own units, exactly as the factory's `fixed_curve`
 * builds it: the two QUOTE figures (opening reserve, graduation target) are whole units
 * times 10^decimals; the token figures do not change. Using the 18-decimal figures for
 * a 6-decimal pair drew a curve, and parsed an opening buy, a trillion times too large.
 *
 * THE OPENING RESERVE COMES FROM THE QUOTE, not from a constant here. It is what sets
 * the market cap a launch opens at, and one number cannot be right for both INJ and a
 * dollar stablecoin: the figure that opens an INJ launch at about $5,000 opens a
 * dollar one at about $630. The factory stores it per allowlisted asset and reports it
 * on `Quotes {}`; `OPENING_RESERVE_QUOTE` below is only the INJ default, for copy that
 * is about the launchpad rather than about a launch.
 */
export function fixedCurveFor(quote: number | { decimals: number; virtualWhole?: number }) {
  /*
   * A bare number still means "this many decimals, default scale", because most
   * callers are about the default quote and widening all of them would be noise. A
   * caller holding a real quote passes the quote.
   */
  const decimals = typeof quote === 'number' ? quote : quote.decimals;
  const whole = typeof quote === 'number' ? OPENING_RESERVE_QUOTE : openingReserveWholeFor(quote);
  const unit = 10n ** BigInt(decimals);
  return {
    ...FIXED_CURVE,
    virtualInj: BigInt(whole) * unit,
    graduationTarget: graduationWholeFor(whole) * unit,
  };
}

/**
 * The opening reserve a launch in THIS quote actually gets, in whole units.
 *
 * ONE RESOLVER, because two places decide this number and they disagreed. The create
 * form states the opening reserve and the graduation target as the fixed terms of the
 * launch, and `fixedCurveFor` builds the curve that gets signed. The form printed the
 * INJ-only `OPENING_RESERVE_QUOTE` beside the SELECTED pair's ticker, so with the
 * 6-decimal E2EUSD pair chosen it read
 *
 *     Graduates at E2EUSD raised   1915 E2EUSD   fixed
 *     Opening reserve              676 E2EUSD    fixed
 *     Curve ceiling                15,689.37 E2EUSD
 *
 * while the factory's allowlist entry for that asset carries 5354, giving a target of
 * 15169. Measured on both deployed E2EUSD curves on 16 Oct 2026: `virtual_inj`
 * 5354000000, `graduation_target` 15169000000. The third row is built through
 * `fixedCurveFor` and agreed with the chain, so the card contradicted itself and the
 * two rows badged "fixed" were the wrong ones - on the screen where a creator reads
 * the terms of something that can never be changed afterwards.
 *
 * The fallback is here rather than at the call site for the same reason: a factory
 * predating the field reports no reserve, and the form and the curve must fall back to
 * the same default or the card starts lying again in the other direction.
 */
export function openingReserveWholeFor(quote: { virtualWhole?: number }): number {
  return quote.virtualWhole ?? OPENING_RESERVE_QUOTE;
}

/**
 * Graduation from the opening reserve: 17/6, floored, mirroring `GRADUATION_NUM` and
 * `GRADUATION_DEN` in the factory.
 *
 * A RATIO rather than a second constant, so every launch has the same curve SHAPE
 * however its quote is scaled: the target is 96.7% of the curve's ceiling and the
 * price multiple from open to graduation is 14.69x, on any asset.
 */
export function graduationWholeFor(virtualWhole: number | bigint): bigint {
  return (BigInt(virtualWhole) * 17n) / 6n;
}

/** The reserve held back for the pool: whatever the fixed supply leaves over. */
export const FIXED_LP_RESERVE = FIXED_TOTAL_SUPPLY - FIXED_CURVE.curveSupply;

/** Whole-token and whole-quote forms, for copy that should not print 27 digits. */
export const CURVE_SUPPLY_TOKENS = 800_000_000;
export const LP_RESERVE_TOKENS = 200_000_000;
/**
 * The opening reserve for the DEFAULT quote (INJ), in whole units.
 *
 * 676 puts a launch's opening market cap at 630 INJ, which was **about $4,990** at the
 * INJ price measured on 11 Oct 2026 (Coinbase 7.923, Binance 7.917). The dollar figure
 * is the premise the number was chosen under, not a property of it: there is no price
 * oracle in this product and nothing renders a dollar amount. Revisit by re-measuring
 * INJ and re-deriving the constant, never by adding a feed.
 *
 * It was 60, which opened at 55.92 INJ, about $443.
 */
export const OPENING_RESERVE_QUOTE = 676;

/*
 * `GRADUATION_TARGET_QUOTE` LIVED HERE, and its only reference anywhere was a test
 * forbidding the create form from printing it. An INJ-only figure of exactly the kind
 * that produced the `1915 E2EUSD` defect `openingReserveWholeFor` records, kept around
 * for nothing but to be refused. Callers derive the target from the quote's own reserve
 * through `graduationWholeFor(openingReserveWholeFor(quote))`.
 */

/**
 * The market cap a launch opens at, in whole units of its quote.
 *
 * `virtualQuote / virtualTokens * totalSupply`, which is the same arithmetic the
 * contract's own test asserts. It is the figure the whole reserve policy was chosen FOR,
 * so the create form states it rather than leaving a creator to infer it from a virtual
 * reserve.
 *
 * TAKES THE RESERVE, never assuming the default. Passing the INJ constant while showing
 * the selected pair's ticker is the one defect this file has already had.
 *
 * The divisor was the literal `1_073_000_000`, a third copy of `virtualTokens` written in
 * whole tokens. Derived now, so a curve reshaping cannot leave the market cap behind.
 */
export function openingMarketCap(virtualWhole: number = OPENING_RESERVE_QUOTE): number {
  const virtualTokensWhole = Number(FIXED_CURVE.virtualTokens / 10n ** 18n);
  return (virtualWhole * Number(FIXED_TOTAL_SUPPLY_TOKENS)) / virtualTokensWhole;
}

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
    detail: `Your ${CREATOR_FEE_SHARE_BPS / 100}% accrues on the launch and you claim it whenever you like.`,
  },
  {
    value: 'pool',
    label: 'To the pool',
    /*
     * BOTH PHASES, because this sentence used to describe only the first and the
     * contract used to implement only the first. It said the share is "paired into the
     * liquidity at graduation", which is true of the curve phase and was the whole of
     * what `apply_route` could do: after graduation the cut went into `lp_bonus`, whose
     * only consumer had already run, so it was stranded rather than routed. The pool
     * phase lasts for the rest of the launch's life, so a route described only up to
     * graduation is a route described for the shorter half.
     */
    detail:
      `Your ${CREATOR_FEE_SHARE_BPS / 100}% goes into the liquidity instead of to you: held back until graduation, then added to the pool's reserve on every trade after it. It deepens the market everyone trades in, and you keep nothing from the fee.`,
  },
];
