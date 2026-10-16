/**
 * Bonding curve maths, mirrored from `packages/launchpad-math` in Rust.
 *
 * This exists so the UI can quote a trade instantly without a round trip to a
 * node. That makes it dangerous: if this disagrees with the contract by even
 * one unit, the quote shown to the user is wrong and trades near the
 * graduation boundary fail on slippage.
 *
 * So it mirrors the Rust exactly, including the direction of every rounding:
 *   - ceiling division wherever the pool must be favoured
 *   - fees rounded UP, off the input
 *   - partial fill on the buy that empties the curve, with a refund
 *
 * `curve.test.mjs` checks the same properties the Rust tests do. If you change
 * one side, change the other.
 */

export const BPS_DENOM = 10_000n;
export const MAX_FEE_BPS = 1_000n;
/** Max u128, the contract's ceiling. Quotes above this cannot be executed. */
export const U128_MAX = (1n << 128n) - 1n;

export interface CurveConfig {
  virtualInj: bigint;
  virtualTokens: bigint;
  curveSupply: bigint;
  graduationTarget: bigint;
  feeBps: bigint;
}

export interface CurveState {
  injCollected: bigint;
  tokensSold: bigint;
  graduated: boolean;
}

export interface BuyQuote {
  fee: bigint;
  injInAfterFee: bigint;
  tokensOut: bigint;
  /** Non-zero only on the buy that empties the curve. */
  refund: bigint;
  graduates: boolean;
}

export interface SellQuote {
  fee: bigint;
  injOut: bigint;
}

export class CurveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurveError';
  }
}

/** Ceiling division. Used wherever rounding must land on the pool's side. */
function ceilDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new CurveError('division by zero in curve maths');
  const q = num / den;
  return q * den === num ? q : q + 1n;
}

/** Fee off an input amount, rounded up so the pool is never short. */
export function feeOn(amount: bigint, bps: bigint): bigint {
  if (bps === 0n) return 0n;
  return ceilDiv(amount * bps, BPS_DENOM);
}

/** Inverse of feeOn: the gross whose net, after fee, covers `net`. */
function grossUp(net: bigint, bps: bigint): bigint {
  if (bps === 0n) return net;
  const den = BPS_DENOM - bps;
  if (den <= 0n) throw new CurveError('fee of 100% or more');
  return ceilDiv(net * BPS_DENOM, den);
}

function k(cfg: CurveConfig): bigint {
  return cfg.virtualInj * cfg.virtualTokens;
}

function reserves(cfg: CurveConfig, st: CurveState): [bigint, bigint] {
  return [cfg.virtualInj + st.injCollected, cfg.virtualTokens - st.tokensSold];
}

export function validate(cfg: CurveConfig): void {
  if (cfg.virtualInj <= 0n || cfg.virtualTokens <= 0n)
    throw new CurveError('virtual reserves must be non-zero');
  if (cfg.feeBps > MAX_FEE_BPS)
    throw new CurveError(`fee ${cfg.feeBps} bps exceeds the ${MAX_FEE_BPS} bps maximum`);
  if (cfg.curveSupply >= cfg.virtualTokens)
    throw new CurveError('curve supply must be under the virtual token reserve');
  if (cfg.graduationTarget <= 0n) throw new CurveError('graduation target must be non-zero');
  if (cfg.graduationTarget > maxCollectable(cfg))
    throw new CurveError(
      'graduation target can never be reached; the curve runs out of tokens first',
    );
}

/** Total INJ the curve can take in before its sellable supply is gone. */
export function maxCollectable(cfg: CurveConfig): bigint {
  const tokLeft = cfg.virtualTokens - cfg.curveSupply;
  if (tokLeft <= 0n) throw new CurveError('curve supply exhausts the reserve');
  const total = ceilDiv(k(cfg), tokLeft);
  return total > cfg.virtualInj ? total - cfg.virtualInj : 0n;
}

export function quoteBuy(cfg: CurveConfig, st: CurveState, injIn: bigint): BuyQuote {
  validate(cfg);
  if (st.graduated) throw new CurveError('this launch has graduated; trading is closed');
  if (injIn <= 0n) throw new CurveError('amount must be greater than zero');

  const remaining = cfg.curveSupply - st.tokensSold;
  if (remaining <= 0n) throw new CurveError('the curve has sold out');

  const feeFull = feeOn(injIn, cfg.feeBps);
  const netFull = injIn - feeFull;
  if (netFull <= 0n) throw new CurveError('amount is too small to cover the fee');

  const [injRes, tokRes] = reserves(cfg, st);
  // Round the remaining token reserve UP, so tokensOut comes out smaller.
  const newTok = ceilDiv(k(cfg), injRes + netFull);
  const wanted = tokRes > newTok ? tokRes - newTok : 0n;

  let fee: bigint, net: bigint, tokensOut: bigint, refund: bigint;

  if (wanted <= remaining) {
    [fee, net, tokensOut, refund] = [feeFull, netFull, wanted, 0n];
  } else {
    // Partial fill: take only the INJ needed to clear the rest of the supply.
    const tokAfter = tokRes - remaining;
    if (tokAfter <= 0n) throw new CurveError('curve maths out of range');
    const netUsed = ceilDiv(k(cfg), tokAfter) - injRes;
    if (netUsed <= 0n) throw new CurveError('amount too small for the remaining supply');
    let grossUsed = grossUp(netUsed, cfg.feeBps);
    if (grossUsed > injIn) grossUsed = injIn;
    fee = grossUsed - netUsed > 0n ? grossUsed - netUsed : 0n;
    net = netUsed;
    tokensOut = remaining;
    refund = injIn - grossUsed > 0n ? injIn - grossUsed : 0n;
  }

  if (tokensOut <= 0n) throw new CurveError('amount too small to buy any tokens');

  return {
    fee,
    injInAfterFee: net,
    tokensOut,
    refund,
    graduates: st.injCollected + net >= cfg.graduationTarget || tokensOut === remaining,
  };
}

export function quoteSell(cfg: CurveConfig, st: CurveState, tokensIn: bigint): SellQuote {
  validate(cfg);
  if (st.graduated) throw new CurveError('this launch has graduated; trading is closed');
  if (tokensIn <= 0n) throw new CurveError('amount must be greater than zero');
  if (tokensIn > st.tokensSold)
    throw new CurveError('cannot sell more than has been bought from the curve');

  const [injRes, tokRes] = reserves(cfg, st);
  // Round the remaining INJ reserve UP, so the payout comes out smaller.
  const newInj = ceilDiv(k(cfg), tokRes + tokensIn);
  let gross = injRes > newInj ? injRes - newInj : 0n;
  if (gross > st.injCollected) gross = st.injCollected;
  if (gross <= 0n) throw new CurveError('amount too small to return any INJ');

  const fee = feeOn(gross, cfg.feeBps);
  return { fee, injOut: gross - fee };
}

/**
 * Price impact of a buy, in basis points, against the spot price before it.
 *
 * Mirrored from `price_impact_bps` in Rust, and covered by the parity vectors like
 * everything else here: the generator emits `impactBps` on every buy row, so a
 * divergence fails the parity test rather than showing a user a number the chain
 * disagrees with.
 *
 * WHY THIS IS SHOWN AT ALL. A one-sided launch puts the whole sellable supply into
 * one curve, so it is steep by construction and steepest at the start. Measured on
 * the shape this project ships:
 *
 *      1 INJ  ->    3.30%
 *      5 INJ  ->   16.50%
 *     25 INJ  ->   82.50%
 *     84 INJ  ->  277.20%
 *
 * The fee is 1%. A panel showing the fee and not the impact discloses a fortieth
 * of what a 25 INJ buy actually costs, and reads as a complete account of it.
 *
 * Measured against spot BEFORE the trade, because that is the number the trader was
 * looking at when they decided; against the price afterwards every trade flatters
 * itself, since the trade is what moved it. The fee is excluded, because it is
 * disclosed on its own line and counting it twice would overstate the curve's cost.
 *
 * Throws rather than returning an "unknown": every unmeasurable case already fails
 * in `quoteBuy` with a reason that names itself, which is a better answer than a
 * featureless null.
 */
export function priceImpactBps(cfg: CurveConfig, st: CurveState, injIn: bigint): number {
  validate(cfg);
  const q = quoteBuy(cfg, st, injIn);
  if (q.tokensOut <= 0n || q.injInAfterFee <= 0n) {
    throw new CurveError('amount too small to measure price impact');
  }

  const [injRes, tokRes] = reserves(cfg, st);
  if (tokRes <= 0n || injRes <= 0n) throw new CurveError('curve maths out of range');

  /*
   * Cross-multiplied, so nothing is divided before the comparison and no
   * intermediate rounding decides the answer:
   *
   *     impact = (injInAfterFee / tokensOut) / (injRes / tokRes) - 1
   *            = (injInAfterFee * tokRes) / (tokensOut * injRes) - 1
   */
  const num = q.injInAfterFee * tokRes;
  const den = q.tokensOut * injRes;
  if (den <= 0n) throw new CurveError('curve maths out of range');
  // A buy cannot fill below spot on a rising curve. Where it appears to, the cause
  // is integer flooring inside the quote at a tiny size, not a discount.
  if (num <= den) return 0;

  const bps = ((num - den) * BPS_DENOM) / den;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
}

/**
 * Price impact of a sell, in basis points BELOW the spot price before it.
 *
 * Mirrored from `sell_price_impact_bps`, and covered by the parity vectors like
 * everything else: the generator emits `impactBps` on sell rows too.
 *
 * The exit had no disclosure while the entry's fee did, and the exit is where a
 * holder is most exposed. Measured on this shape, from the warm state:
 *
 *     152,625,000 tokens  ->  24.81% below spot
 *     610,500,000 tokens  ->  56.89% below spot
 *
 * A shortfall rather than a premium, because that is the direction it runs: a
 * seller receives less than spot where a buyer pays more. One signed number would
 * make the thresholds ambiguous about which way is bad.
 *
 * Below 100% for every input, as a property of the arithmetic rather than a clamp:
 * see the note at the return. A sell cannot be worth less than nothing, and the
 * maximum observed across extreme states is 9999 bps.
 */
export function sellPriceImpactBps(cfg: CurveConfig, st: CurveState, tokensIn: bigint): number {
  validate(cfg);
  const q = quoteSell(cfg, st, tokensIn);
  const gross = q.injOut + q.fee;
  if (gross <= 0n || tokensIn <= 0n) {
    throw new CurveError('amount too small to measure price impact');
  }

  const [injRes, tokRes] = reserves(cfg, st);
  if (tokRes <= 0n || injRes <= 0n) throw new CurveError('curve maths out of range');

  // impact = 1 - (gross / tokensIn) / (injRes / tokRes)
  //        = (tokensIn * injRes - gross * tokRes) / (tokensIn * injRes)
  const atSpot = tokensIn * injRes;
  const actual = gross * tokRes;
  if (atSpot <= 0n) throw new CurveError('curve maths out of range');
  // A sell cannot pay above spot here; where it appears to, the cause is integer
  // flooring at a tiny size, not a bonus.
  if (actual >= atSpot) return 0;

  /*
   * The result is below 10,000 bps structurally, not by clamping.
   *
   * There was a `Math.min` here and it was dead code. Above we already return 0
   * when `actual >= atSpot`, so `0 <= actual < atSpot`, which makes
   * `(atSpot - actual) < atSpot` and therefore `bps < BPS_DENOM` for every input.
   * Swept across extreme states and sizes the maximum observed is 9999.
   *
   * Removed rather than left in: a clamp that cannot engage reads as a real bound
   * somebody might rely on, and a test asserting it passes without exercising
   * anything. The bound is worth knowing and it belongs in a comment, not a branch.
   */
  const bps = ((atSpot - actual) * BPS_DENOM) / atSpot;
  return Number(bps);
}

/**
 * Where the chart's "you are here" marker belongs.
 *
 * EXTRACTED SO IT CAN BE TESTED. This lived inside the component's render and was
 * wrong: it placed the marker at `maxX * graduationProgress(cfg, st)`, where `maxX`
 * is the curve's ceiling (`maxCollectable`, 87.912 on this shape) and
 * `graduationProgress` divides by the graduation target (85). So the marker sat
 * 3.4% further right than the launch actually was at every point, and at graduation
 * it landed on the ceiling rather than on the target it was marking.
 *
 * The first guard written for the fix asserted on the component's SOURCE — that it
 * mentioned `injCollected` and did not contain the string `maxX * progress`. A
 * mutation rewriting the overshoot in different words passed it. Asserting on the
 * text of a calculation is not testing the calculation, so the calculation moved
 * here where its behaviour can be checked.
 *
 * `price` is the real spot price for the state rather than the nearest sampled
 * point, which needs no interpolation and cannot drift from the line it sits on.
 */
export function chartMarker(
  cfg: CurveConfig,
  st: CurveState,
  axisMaxInj: number,
  oneToken: bigint = 10n ** 18n,
): { injX: number; price: number } {
  const raised = Number(st.injCollected) / Number(oneToken);
  // Clamped so a state past the ceiling cannot be drawn off the end of the axis.
  const injX = Math.min(Math.max(raised, 0), axisMaxInj);
  let price = 0;
  try {
    price = Number(spotPrice(cfg, st, oneToken)) / Number(oneToken);
  } catch {
    // An unplottable state leaves the marker on the floor rather than throwing out
    // the whole chart: the line is still true even when the marker cannot be placed.
    price = 0;
  }
  return { injX, price };
}

/**
 * The locked pool a launch becomes at graduation, mirrored from
 * `packages/launchpad-math/src/pool.rs`.
 *
 * Plain `x * y = k` over REAL reserves, fees on the quote leg only, every division
 * rounded toward the pool. Covered by the `pool*` rows in the parity vectors, so a
 * one-unit drift from the contract fails a test rather than a trade.
 */
export interface PoolReserves {
  quote: bigint;
  tokens: bigint;
}

export interface PoolBuyQuote {
  fee: bigint;
  quoteInAfterFee: bigint;
  tokensOut: bigint;
}

function checkPool(pool: PoolReserves, feeBps: bigint): void {
  if (pool.quote <= 0n || pool.tokens <= 0n) throw new CurveError('the pool has no liquidity');
  if (feeBps > MAX_FEE_BPS) throw new CurveError('fee above the maximum');
}

export function poolQuoteBuy(pool: PoolReserves, feeBps: bigint, quoteIn: bigint): PoolBuyQuote {
  checkPool(pool, feeBps);
  if (quoteIn <= 0n) throw new CurveError('amount must be greater than zero');
  const fee = feeOn(quoteIn, feeBps);
  const net = quoteIn - fee;
  if (net <= 0n) throw new CurveError('amount must be greater than zero');
  const newTokens = ceilDiv(pool.quote * pool.tokens, pool.quote + net);
  const tokensOut = pool.tokens > newTokens ? pool.tokens - newTokens : 0n;
  if (tokensOut <= 0n) throw new CurveError('amount must be greater than zero');
  return { fee, quoteInAfterFee: net, tokensOut };
}

export function poolQuoteSell(pool: PoolReserves, feeBps: bigint, tokensIn: bigint): SellQuote {
  checkPool(pool, feeBps);
  if (tokensIn <= 0n) throw new CurveError('amount must be greater than zero');
  const newQuote = ceilDiv(pool.quote * pool.tokens, pool.tokens + tokensIn);
  const gross = pool.quote > newQuote ? pool.quote - newQuote : 0n;
  if (gross <= 0n) throw new CurveError('amount must be greater than zero');
  const fee = feeOn(gross, feeBps);
  const injOut = gross - fee;
  if (injOut <= 0n) throw new CurveError('amount must be greater than zero');
  return { fee, injOut };
}

export function poolSpotPrice(pool: PoolReserves, oneToken: bigint): bigint {
  if (pool.tokens <= 0n) throw new CurveError('the pool has no liquidity');
  return (pool.quote * oneToken) / pool.tokens;
}

const toBpsNumber = (b: bigint) =>
  b > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(b);

/** Buy impact against spot before the trade, fee excluded; same definition as the curve's. */
export function poolBuyImpactBps(pool: PoolReserves, feeBps: bigint, quoteIn: bigint): number {
  const q = poolQuoteBuy(pool, feeBps, quoteIn);
  const num = q.quoteInAfterFee * pool.tokens;
  const den = q.tokensOut * pool.quote;
  if (num <= den) return 0;
  return toBpsNumber(((num - den) * BPS_DENOM) / den);
}

/** Sell shortfall below spot before the trade, fee excluded. */
export function poolSellImpactBps(pool: PoolReserves, feeBps: bigint, tokensIn: bigint): number {
  const q = poolQuoteSell(pool, feeBps, tokensIn);
  const atSpot = tokensIn * pool.quote;
  const actual = (q.injOut + q.fee) * pool.tokens;
  if (actual >= atSpot) return 0;
  return toBpsNumber(((atSpot - actual) * BPS_DENOM) / atSpot);
}

/** At or above this, say so prominently. 5%. */
export const IMPACT_WARN_BPS = 500;
/** At or above this, the trader is losing a quarter of their money to the shape. 25%. */
export const IMPACT_SEVERE_BPS = 2_500;

/** Price of one whole token in the smallest quote unit. Display only. */
export function spotPrice(cfg: CurveConfig, st: CurveState, oneToken: bigint): bigint {
  validate(cfg);
  const [injRes, tokRes] = reserves(cfg, st);
  if (tokRes <= 0n) throw new CurveError('curve maths out of range');
  return (injRes * oneToken) / tokRes;
}

/**
 * The price a launch trades at right now: the pool's once graduated, else the curve's.
 *
 * One function so no page can quote a graduated launch off its exhausted curve, which
 * would read the curve's terminal state rather than the market that replaced it.
 */
export function launchSpotPrice(
  cfg: CurveConfig,
  st: CurveState,
  pool: PoolReserves | null | undefined,
  oneToken: bigint,
): bigint {
  if (pool && pool.quote > 0n && pool.tokens > 0n) return poolSpotPrice(pool, oneToken);
  return spotPrice(cfg, st, oneToken);
}

/** The reserves a launch currently prices against: the pool's once graduated, else the curve's. */
function pricingReserves(
  cfg: CurveConfig,
  st: CurveState,
  pool: PoolReserves | null | undefined,
): [bigint, bigint] {
  if (pool && pool.quote > 0n && pool.tokens > 0n) return [pool.quote, pool.tokens];
  validate(cfg);
  return reserves(cfg, st);
}

/** Extra fixed-point precision for prices, so a sub-unit price is not floored to zero. */
export const PRICE_WAD = 10n ** 18n;

/**
 * Spot price of one whole token in quote base units, multiplied by `PRICE_WAD`.
 *
 * `spotPrice` floors to a whole quote base unit, which is fine for an 18-decimal quote
 * and wrong for a 6-decimal one: a token on this curve costs about 0.04 of a USDC base
 * unit, so the floored price was 0 and every USDC launch showed price 0 and market cap
 * 0 (seen live on TUSD and 0x… pairs). Render with `decimals + 18`.
 */
export function spotPriceWad(
  cfg: CurveConfig,
  st: CurveState,
  pool: PoolReserves | null | undefined,
  oneToken: bigint,
): bigint {
  const [q, t] = pricingReserves(cfg, st, pool);
  if (t <= 0n) throw new CurveError('curve maths out of range');
  return (q * oneToken * PRICE_WAD) / t;
}

/**
 * Market cap in quote base units, computed from the reserves in one division so no
 * intermediate per-token price is rounded away: quoteReserve * supply / tokenReserve.
 */
export function marketCapExact(
  cfg: CurveConfig,
  st: CurveState,
  pool: PoolReserves | null | undefined,
  totalSupply: bigint,
): bigint {
  const [q, t] = pricingReserves(cfg, st, pool);
  if (t <= 0n) throw new CurveError('curve maths out of range');
  return (q * totalSupply) / t;
}

/** How far along the curve this launch is, 0..1, for progress bars. */
export function graduationProgress(cfg: CurveConfig, st: CurveState): number {
  // A graduated curve's reserve has moved into the pool, so `injCollected` reads zero
  // afterwards; without this a finished launch would show 0% on every bar.
  if (st.graduated) return 1;
  if (cfg.graduationTarget <= 0n) return 0;
  if (st.injCollected >= cfg.graduationTarget) return 1;
  return Number((st.injCollected * 10_000n) / cfg.graduationTarget) / 10_000;
}

/**
 * The state a launch is in once it has raised `raised`, derived from the shape alone.
 *
 * For drawing and for simulating, never for a live launch: a real one's `tokensSold`
 * is read from the contract. This answers the hypothetical "where would a launch
 * be if it had raised this much", which is what a sampled line and a draggable
 * handle both need.
 *
 * IT EXISTS BECAUSE IT WAS WRITTEN TWICE. `curvePoints` had it, and `CurveExplorer`
 * had a second copy that used plain division where this rounds the reserve UP, so
 * the handle's quote and the line it was drawn under disagreed by a unit at every
 * position. Worse, the duplication is what let `CurveChart`'s axis-basis fix fail to
 * reach the explorer: positioning that lives inside a component is out of reach of
 * every test, which `curve-chart.test.ts` already says in its last assertion.
 */
export function stateAtRaised(cfg: CurveConfig, raised: bigint): CurveState {
  const tokensSold = cfg.virtualTokens - ceilDiv(k(cfg), cfg.virtualInj + raised);
  return {
    injCollected: raised,
    tokensSold: tokensSold > cfg.curveSupply ? cfg.curveSupply : tokensSold,
    graduated: false,
  };
}

/**
 * Sample the curve for plotting: price per token against INJ raised.
 * Pure projection from the config, so it does not depend on live state.
 */
export function curvePoints(
  cfg: CurveConfig,
  oneToken: bigint,
  samples = 60,
): Array<{ injRaised: number; price: number }> {
  const max = maxCollectable(cfg);
  const out: Array<{ injRaised: number; price: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const raised = (max * BigInt(i)) / BigInt(samples);
    const st = stateAtRaised(cfg, raised);
    out.push({
      injRaised: Number(raised) / Number(oneToken),
      price: Number(spotPrice(cfg, st, oneToken)) / Number(oneToken),
    });
  }
  return out;
}

/** Format a raw 18-decimal amount for display. */
export function fmt(raw: bigint, decimals = 18, places = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (places === 0) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

/** Parse a human amount like "1.5" into a raw 18-decimal bigint. */
export function parseAmount(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) throw new CurveError('not a number');
  const [whole = '0', frac = ''] = trimmed.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}
