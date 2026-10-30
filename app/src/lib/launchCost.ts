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
 * Mainnet's fee, which is NOT testnet's.
 *
 * Measured 12 Oct 2026: testnet charges 1 INJ and **mainnet charges 0.1 INJ**. The
 * constant above was taken from testnet and would have told a mainnet creator they
 * need 1.25 INJ when they need 0.35, refusing launches they can comfortably afford,
 * from a pre-flight check written to stop exactly that kind of refusal.
 *
 * Found by querying mainnet rather than by assuming the chains agree, which is the
 * only reason it was found at all: both numbers are plausible and nothing on screen
 * would have looked wrong.
 */
export const DENOM_CREATION_FEE_MAINNET = 100_000_000_000_000_000n;

/**
 * The fee for a network, used when the chain has not been asked.
 *
 * A FALLBACK, not the answer. `fetchDenomCreationFee` reads the chain parameter,
 * which is authoritative and can change without anybody editing this file; this is
 * what the form uses until that resolves, and what it falls back to if the LCD is
 * unreachable. Erring high on testnet is harmless; erring high on mainnet would
 * refuse a fundable launch, which is why mainnet gets its own measured number
 * rather than inheriting testnet's.
 */
export function denomCreationFeeFor(network: string): bigint {
  /*
   * ZERO ON THE EVM BACKEND, AND THIS WAS BLOCKING LAUNCHES.
   *
   * The fee is Injective's charge for creating a tokenfactory denom. There is no
   * tokenfactory on the EVM side: a launch deploys two contracts and pays gas, and
   * nothing charges a flat amount. The fallback is reached there too, because
   * `fetchDenomCreationFee` asks a CosmWasm LCD route against a JSON-RPC host and
   * gets nothing - which is correctly treated as "unread" and correctly falls back to
   * the measured constant, so this function was returning 1 INJ for a fee that does
   * not exist. `launchAffordable` then refused every creator holding under about
   * 1.05 INJ, with copy telling them the money was "Injective's own one-off charge
   * for a new denom".
   *
   * Erring high is the safe direction for a fee that is real and might have changed.
   * It is not safe for one that is not charged at all: there the whole number is
   * invented, and the pre-flight check written to stop a creator signing a doomed
   * transaction was instead stopping them signing a sound one.
   */
  if (network === 'evm') return 0n;
  return network === 'mainnet' ? DENOM_CREATION_FEE_MAINNET : DENOM_CREATION_FEE;
}

/**
 * The chain's own `denom_creation_fee`, which is the authority.
 *
 * Returns null rather than a guess when it cannot be read, so the caller falls back
 * to the measured constant for its network instead of to zero: a zero fee would
 * under-report the cost and put the failure back where it was, after signing.
 */
export async function fetchDenomCreationFee(lcd: string): Promise<bigint | null> {
  try {
    const res = await fetch(`${lcd.replace(/\/+$/, '')}/${DENOM_FEE_SOURCE}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      params?: { denom_creation_fee?: Array<{ denom?: string; amount?: string }> };
    };
    const inj = body.params?.denom_creation_fee?.find((c) => c.denom === 'inj');
    if (!inj?.amount || !/^[0-9]+$/.test(inj.amount)) return null;
    return BigInt(inj.amount);
  } catch {
    return null;
  }
}

/**
 * Gas to leave behind for the five messages of a launch.
 *
 * Deliberately generous. The cost of overestimating is telling somebody to add a
 * little more INJ; the cost of underestimating is the exact failure this module
 * exists to prevent, after they have signed.
 */
export const LAUNCH_GAS_RESERVE = 50_000_000_000_000_000n; // 0.05 INJ

/**
 * The EVM backend's reserve, which is a hundred times smaller because the launch is.
 *
 * MEASURED AGAINST THE LIVE FACTORY, 30 Oct 2026. `eth_estimateGas` on `createLaunch`
 * returned **2,588,418** gas at a **0.16 gwei** gas price, so a creation costs
 * **0.000414 INJ**. A buy is 82,756 gas, 0.0000132 INJ.
 *
 * The CosmWasm reserve above is five messages including a tokenfactory denom creation,
 * and "deliberately generous" is the right call there. Applied here it was 120x the
 * real cost, and it did the exact thing this module exists to prevent, in the other
 * direction: a creator holding **0.0085 INJ** - enough for twenty launches - was told
 * "This wallet holds 0.0085 INJ. Creating a token costs 0.05 INJ. Top the wallet up
 * and this will unlock." Erring high is harmless for a fee that might have changed;
 * it is not harmless when it refuses a launch somebody can afford.
 *
 * 0.005 INJ is still a 12x margin over the measurement, which covers a gas price
 * spike and the contract growing, without inventing two orders of magnitude.
 */
export const LAUNCH_GAS_RESERVE_EVM = 5_000_000_000_000_000n; // 0.005 INJ

/**
 * The reserve for a network. Same shape as `denomCreationFeeFor`, and for the same
 * reason: the figure is per chain and a single constant was wrong on one of them.
 */
export function launchGasReserveFor(network: string): bigint {
  return network === 'evm' ? LAUNCH_GAS_RESERVE_EVM : LAUNCH_GAS_RESERVE;
}

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
  denomFee = DENOM_CREATION_FEE,
  gasReserve = LAUNCH_GAS_RESERVE,
  quoteDenom,
  gasDenom,
}: {
  openingBuy?: bigint;
  /** The launchpad's own charge, from the factory's config. */
  launchFee?: bigint;
  launchFeeDenom?: string;
  /** The chain's denom creation fee. Differs per network; read it, do not assume. */
  denomFee?: bigint;
  /**
   * Held back for gas. Differs per backend by two orders of magnitude, so it is a
   * parameter rather than the constant it used to read directly - see
   * `launchGasReserveFor`. Defaulted to the CosmWasm figure so every existing caller
   * and every existing test keeps its behaviour.
   */
  gasReserve?: bigint;
  quoteDenom: string;
  gasDenom: string;
}): LaunchCost {
  const buy = quoteDenom === gasDenom ? openingBuy : 0n;
  // Counted only when it is charged in the gas asset, for the same reason the
  // opening buy is: a fee in another denom has no claim on this balance.
  const fee = !launchFeeDenom || launchFeeDenom === gasDenom ? launchFee : 0n;
  return {
    denomFee,
    launchFee: fee,
    gasReserve,
    openingBuy: buy,
    total: denomFee + fee + gasReserve + buy,
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
