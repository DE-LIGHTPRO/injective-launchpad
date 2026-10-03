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

/** How far along the curve this launch is, 0..1, for progress bars. */
export function graduationProgress(cfg: CurveConfig, st: CurveState): number {
  if (cfg.graduationTarget <= 0n) return 0;
  if (st.injCollected >= cfg.graduationTarget) return 1;
  return Number((st.injCollected * 10_000n) / cfg.graduationTarget) / 10_000;
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
    const tokensSold = cfg.virtualTokens - ceilDiv(k(cfg), cfg.virtualInj + raised);
    const st: CurveState = {
      injCollected: raised,
      tokensSold: tokensSold > cfg.curveSupply ? cfg.curveSupply : tokensSold,
      graduated: false,
    };
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
