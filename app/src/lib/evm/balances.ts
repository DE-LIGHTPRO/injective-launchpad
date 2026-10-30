/**
 * Balances and per-account reads on the EVM backend.
 *
 * THESE ARE THE EVM HALVES OF FUNCTIONS THAT ALREADY EXIST, and the names say which:
 * `nativeBalance` answers `wallet.quoteBalance`, `denomBalanceEvm` answers
 * `wallet.denomBalance`, and so on. Keeping them here rather than inlining an EVM
 * branch into each caller is the same seam `read.ts` describes: the panels above
 * never learn there are two chains.
 *
 * READ THROUGH OUR OWN CLIENT, NEVER THROUGH THE WALLET. `window.ethereum` answers
 * about whichever chain the extension is currently pointed at, so an
 * `eth_getBalance` through it reports a mainnet Ethereum balance to a user who has
 * not switched yet. `evmClient()` is pinned to the configured RPC, which is the
 * chain every other number on the screen came from. `wallet.denomBalance` gives the
 * same reason for reading the LCD rather than the extension; this is that reason on
 * the other backend.
 *
 * `null` IS NOT ZERO, throughout, for the reason `denomBalance` records: an
 * unreachable endpoint rendered as "0" tells a holder their position is gone, which
 * on a sell screen is the most alarming possible lie.
 */
import { erc20Abi, isAddress, type Address } from 'viem';

import { NETWORK } from '../config.ts';
import { CURVE_ABI, FACTORY_ABI } from './abi.ts';
import { evmDenom, tokenAddressOf } from './denom.ts';
import { evmClient, factory, listEvmLaunches } from './read.ts';

/** The connected account's native INJ, which on this chain is the quote asset. */
export async function nativeBalance(address: string): Promise<bigint | null> {
  if (!isAddress(address)) return null;
  try {
    return await evmClient().getBalance({ address });
  } catch {
    return null;
  }
}

export async function erc20Balance(token: string, holder: string): Promise<bigint | null> {
  if (!isAddress(token) || !isAddress(holder)) return null;
  try {
    return await evmClient().readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
  } catch {
    return null;
  }
}

/**
 * One denom's balance, where a denom on this backend is either `inj` or the
 * `evm/0x…/SYMBOL` form `denom.ts` builds.
 *
 * An unrecognised denom returns `null` rather than zero. A CosmWasm `factory/…`
 * denom reaching this function means something upstream mixed the backends, and
 * answering zero for it would report an empty position for a token the user may
 * well hold somewhere else.
 */
export async function denomBalanceEvm(address: string, denom: string): Promise<bigint | null> {
  if (denom === NETWORK.quoteDenom || denom === NETWORK.gasDenom) {
    return nativeBalance(address);
  }
  const token = tokenAddressOf(denom);
  if (token === null) return null;
  return erc20Balance(token, address);
}

/**
 * Everything the account holds that this app can name, as the same denom-keyed map
 * `wallet.allBalances` returns.
 *
 * THERE IS NO `allBalances` ON AN EVM CHAIN, and that is the whole difficulty. A
 * Cosmos bank module can be asked what an account holds; an EVM account's holdings
 * are only discoverable by asking each token contract. So this enumerates the
 * launches this factory created and asks those - which means a portfolio here is
 * "your position in launches from this launchpad", not "everything in your wallet".
 * That is a narrower claim than the Cosmos side makes, and the one thing that must
 * not happen is presenting it as the wider one; `Portfolio` already describes itself
 * as holdings cross-referenced against the board, which is exactly this set.
 *
 * ONE MULTICALL, NOT ONE REQUEST PER LAUNCH. Twenty launches is twenty `balanceOf`
 * calls, and `read.ts` records what a per-read fan-out does to a single JSON-RPC
 * endpoint.
 *
 * A FAILED LAUNCH LIST IS `null`, NOT AN EMPTY WALLET - the distinction this whole
 * file turns on. A per-token read that fails individually is omitted rather than
 * recorded as zero, for the same reason.
 */
export async function allBalancesEvm(address: string): Promise<Record<string, bigint> | null> {
  if (!isAddress(address)) return null;

  const native = await nativeBalance(address);
  if (native === null) return null;

  let rows: Awaited<ReturnType<typeof listEvmLaunches>>;
  try {
    rows = await listEvmLaunches();
  } catch {
    return null;
  }

  const out: Record<string, bigint> = { [NETWORK.quoteDenom]: native };
  if (rows.length === 0) return out;

  let results: Array<{ status: 'success' | 'failure'; result?: unknown }>;
  try {
    results = await evmClient().multicall({
      contracts: rows.map((r) => ({
        address: r.token,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      })),
      allowFailure: true,
    });
  } catch {
    return null;
  }

  rows.forEach((row, i) => {
    const r = results[i];
    if (!r || r.status !== 'success' || typeof r.result !== 'bigint') return;
    // Zero is omitted rather than listed: the portfolio shows positions, and a row of
    // nothing for every launch on the board is noise that hides the real ones.
    if (r.result === 0n) return;
    out[evmDenom(row.token, row.symbol)] = r.result;
  });

  return out;
}

/**
 * How much of the curve's supply this address has bought, for the per-wallet cap.
 *
 * The contract keeps this itself (`purchasedFromCurve`), so unlike the CosmWasm side
 * there is no raw storage key to construct. A read that fails is `null`, and
 * `TradePanel` treats an unread cap as unknown rather than as headroom.
 */
export async function purchasedFromCurveEvm(
  curve: string,
  address: string,
): Promise<bigint | null> {
  if (!isAddress(curve) || !isAddress(address)) return null;
  try {
    return await evmClient().readContract({
      address: curve,
      abi: CURVE_ABI,
      functionName: 'purchasedFromCurve',
      args: [address],
    });
  } catch {
    return null;
  }
}

/** The factory's launch fee, in native INJ. Zero when it has been waived. */
export async function launchFeeEvm(): Promise<{ amount: bigint; denom: string } | null> {
  let f: Address;
  try {
    f = factory();
  } catch {
    return null;
  }
  if (!isAddress(f)) return null;
  try {
    const amount = await evmClient().readContract({
      address: f,
      abi: FACTORY_ABI,
      functionName: 'launchFee',
    });
    return { amount, denom: NETWORK.quoteDenom };
  } catch {
    return null;
  }
}
