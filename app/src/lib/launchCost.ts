/**
 * What creating a launch costs, and whether this wallet can pay it.
 *
 * THE DEFECT THIS EXISTS FOR, reported from production. A creator filled in the
 * whole form, read the six-line summary, ticked the irreversibility box, clicked
 * Create, opened their wallet and signed. The chain then refused the transaction and
 * the page said "The chain refused the transaction. Nothing was created and nothing
 * was spent beyond the fee."
 *
 * The actual reason, measured by simulating the same message:
 *
 *   spendable balance 403213882356322213inj is smaller than 1000000000000000000inj
 *
 * Injective charges a flat **1 INJ** to create a tokenfactory denom
 * (`/injective/tokenfactory/v1beta1/params`, measured), and the wallet held 0.403.
 * Both numbers were known to the page before anything was signed. Nothing checked.
 *
 * So the fix is not a better error, it is not asking somebody to sign a transaction
 * that cannot land. `scripts/dry-run-create.mjs` has done exactly this check on the
 * command line for weeks, which is its own lesson: the tooling knew and the product
 * did not.
 */

/**
 * Injective's tokenfactory denom creation fee, in base units.
 *
 * A CHAIN PARAMETER, not a guess: `denom_creation_fee` on
 * `/injective/tokenfactory/v1beta1/params`, measured as 1 INJ on testnet on
 * 12 Oct 2026. It is mirrored here rather than fetched on every keystroke, and
 * `DENOM_FEE_SOURCE` is what the copy cites so a reader can check it themselves.
 *
 * If Injective ever changes it, this becomes too low and the pre-flight stops
 * catching the case: that fails SAFE, back to the behaviour before this existed,
 * rather than blocking a launch somebody could actually afford.
 */
export const DENOM_CREATION_FEE = 1_000_000_000_000_000_000n;

export const DENOM_FEE_SOURCE = 'injective/tokenfactory/v1beta1/params';

/**
 * Gas to leave behind for the five messages of a launch.
 *
 * Deliberately generous. The cost of overestimating is telling somebody to add a
 * little more INJ; the cost of underestimating is the exact failure this module
 * exists to prevent, after they have signed.
 */
export const LAUNCH_GAS_RESERVE = 50_000_000_000_000_000n; // 0.05 INJ

export interface LaunchCost {
  /** The chain's denom creation fee. Injective's, not the launchpad's. */
  denomFee: bigint;
  /** The launchpad's own charge, when one is configured. */
  launchFee: bigint;
  /** Held back for gas. */
  gasReserve: bigint;
  /** The creator's own opening buy, when it is in the gas asset. */
  openingBuy: bigint;
  /** Everything the wallet must hold in the gas asset. */
  total: bigint;
}

/**
 * What this launch will need in the GAS asset.
 *
 * `openingBuy` is counted only when the launch is priced in the gas asset. A dev buy
 * on a USDC-paired launch is spent in USDC and has no claim on the INJ balance, and
 * adding it here would refuse a launch the creator can comfortably afford. That
 * distinction is the same one `gasReserveFor` already draws in the trade panel.
 */
export function launchCost({
  openingBuy = 0n,
  launchFee = 0n,
  launchFeeDenom,
  quoteDenom,
  gasDenom,
}: {
  openingBuy?: bigint;
  /** The launchpad's own charge, from the factory's config. */
  launchFee?: bigint;
  launchFeeDenom?: string;
  quoteDenom: string;
  gasDenom: string;
}): LaunchCost {
  const buy = quoteDenom === gasDenom ? openingBuy : 0n;
  // Counted only when it is charged in the gas asset, for the same reason the
  // opening buy is: a fee in another denom has no claim on this balance.
  const fee = !launchFeeDenom || launchFeeDenom === gasDenom ? launchFee : 0n;
  return {
    denomFee: DENOM_CREATION_FEE,
    launchFee: fee,
    gasReserve: LAUNCH_GAS_RESERVE,
    openingBuy: buy,
    total: DENOM_CREATION_FEE + fee + LAUNCH_GAS_RESERVE + buy,
  };
}

/**
 * Whether the wallet can pay, or `null` when the balance is not known.
 *
 * `null` IS NOT "NO". An unreachable LCD must not block a launch, because the
 * balance being unreadable says nothing about whether it is sufficient; the chain
 * remains the authority and the old behaviour (sign, and find out) is the right
 * fallback. Only a balance we actually read may refuse.
 */
export function launchAffordable(balance: bigint | null, cost: LaunchCost): boolean | null {
  if (balance === null) return null;
  return balance >= cost.total;
}
