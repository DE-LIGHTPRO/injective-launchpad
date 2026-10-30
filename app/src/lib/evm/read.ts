/**
 * Reading launches from the EVM factory, in the shapes `chain.ts` already returns.
 *
 * THE SEAM IS THE TYPES, NOT THE TRANSPORT. Everything above these functions - the
 * board, the trade panel, the charts, every guard - consumes `Launch`,
 * `LaunchDetail`, `CurveConfig` and `CurveState` from `curve.ts`, which say nothing
 * about which chain produced them. So this file's whole job is to return exactly
 * those, and the 184 files that are not `chain.ts` never learn a second backend
 * exists.
 *
 * MULTICALL, NOT A LOOP. A launch detail is fifteen reads, and a board of twenty
 * launches is three hundred. Over one JSON-RPC endpoint, issued one at a time, that
 * is a page that takes ten seconds and a provider that starts refusing. Injective's
 * EVM exposes the standard Multicall3 at the canonical address, so viem batches them
 * into one call; `batchOrFail` below says what happens when it is absent.
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';

import { NETWORK, getFactoryAddress } from '../config.ts';
import type { CurveConfig, CurveState, PoolReserves } from '../curve.ts';
import { CURVE_ABI, ERC20_ABI, FACTORY_ABI } from './abi.ts';

/** Deployed at the same address on every chain that has it. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

let cached: PublicClient | null = null;

export function evmClient(): PublicClient {
  if (cached) return cached;
  cached = createPublicClient({
    transport: http(NETWORK.lcd, { batch: true }),
    chain: {
      id: Number(NETWORK.chainId),
      name: 'Injective EVM',
      nativeCurrency: { name: 'Injective', symbol: NETWORK.gasSymbol, decimals: NETWORK.gasDecimals },
      rpcUrls: { default: { http: [NETWORK.lcd] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    },
  }) as PublicClient;
  return cached;
}

export function factory(): Address {
  return getFactoryAddress() as Address;
}

export interface EvmLaunchRow {
  id: number;
  curve: Address;
  token: Address;
  creator: Address;
  createdAt: number;
}

export async function launchCount(): Promise<number> {
  const n = await evmClient().readContract({
    address: factory(),
    abi: FACTORY_ABI,
    functionName: 'launchCount',
  });
  return Number(n);
}

/**
 * Every launch on the factory, newest first.
 *
 * Reads the rows AND each token's name and symbol, because a board row with an
 * address where a ticker belongs is not a board. The two passes are each batched.
 */
export async function listEvmLaunches(limit = 100): Promise<Array<EvmLaunchRow & { name: string; symbol: string }>> {
  const total = await launchCount();
  if (total === 0) return [];

  const ids = Array.from({ length: Math.min(total, limit) }, (_, i) => total - 1 - i).filter((i) => i >= 0);

  const rows = await evmClient().multicall({
    contracts: ids.map((id) => ({
      address: factory(),
      abi: FACTORY_ABI,
      functionName: 'launches' as const,
      args: [BigInt(id)] as const,
    })),
    allowFailure: false,
  });

  const launches: EvmLaunchRow[] = rows.map((r, i) => {
    const [curve, token, creator, createdAt] = r as unknown as [Address, Address, Address, bigint];
    return { id: ids[i], curve, token, creator, createdAt: Number(createdAt) };
  });

  const meta = await evmClient().multicall({
    contracts: launches.flatMap((l) => [
      { address: l.token, abi: ERC20_ABI, functionName: 'name' as const },
      { address: l.token, abi: ERC20_ABI, functionName: 'symbol' as const },
    ]),
    allowFailure: true,
  });

  return launches.map((l, i) => ({
    ...l,
    // A token whose metadata call failed still gets a row: the launch exists on
    // chain either way, and hiding it would make a read failure look like an
    // absence, which is the mistake `board-partial-read` records on the other side.
    name: meta[i * 2]?.status === 'success' ? (meta[i * 2].result as string) : '',
    symbol: meta[i * 2 + 1]?.status === 'success' ? (meta[i * 2 + 1].result as string) : '',
  }));
}

export interface EvmDetail {
  token: Address;
  /** The ERC-20 ticker, so the detail can name the token the board names. */
  symbol: string;
  creator: Address;
  lpReserve: bigint;
  rewardRoute: 'creator' | 'pool';
  config: CurveConfig;
  state: CurveState;
  migrated: boolean;
  pool: PoolReserves | null;
  platformOwed: bigint;
  creatorOwed: bigint;
  platformPaid: bigint;
  creatorPaid: bigint;
  lpBonus: bigint;
  currentFeeBps: number;
  currentSellFeeBps: number;
  /** 0 means no cap, which is what the contract stores for an uncapped launch. */
  maxPerWallet: bigint;
  tradeStart: bigint;
}

/**
 * Everything the trade panel needs, in one batched call.
 *
 * The curve's shape parameters are private on the contract (they are immutables
 * behind the quote functions), so `virtualInj`, `curveSupply` and the rest come from
 * the factory's constants plus the launch's own `quoteBuy`, which is the source the
 * contract itself trades on. Reconstructing them from a second place would let the
 * panel price a curve differently from the curve.
 */
export async function getEvmDetail(curve: Address): Promise<EvmDetail> {
  const c = { address: curve, abi: CURVE_ABI } as const;

  const r = await evmClient().multicall({
    contracts: [
      { ...c, functionName: 'TOKEN' },
      { ...c, functionName: 'CREATOR' },
      { ...c, functionName: 'LP_RESERVE' },
      { ...c, functionName: 'REWARD_ROUTE' },
      { ...c, functionName: 'injCollected' },
      { ...c, functionName: 'tokensSold' },
      { ...c, functionName: 'graduated' },
      { ...c, functionName: 'migrated' },
      { ...c, functionName: 'poolQuote' },
      { ...c, functionName: 'poolTokens' },
      { ...c, functionName: 'platformOwed' },
      { ...c, functionName: 'creatorOwed' },
      { ...c, functionName: 'platformPaid' },
      { ...c, functionName: 'creatorPaid' },
      { ...c, functionName: 'lpBonus' },
      { ...c, functionName: 'currentFeeBps' },
      { ...c, functionName: 'currentSellFeeBps' },
      { ...c, functionName: 'curveParams' },
      { ...c, functionName: 'MAX_PER_WALLET' },
      { ...c, functionName: 'TRADE_START' },
    ],
    allowFailure: false,
  });

  const [
    token, creator, lpReserve, route, injCollected, tokensSold, graduated, migrated,
    poolQuote, poolTokens, platformOwed, creatorOwed, platformPaid, creatorPaid,
    lpBonus, feeBps, feeSellBps, params, maxPerWallet, tradeStart,
  ] = r as unknown as [
    Address, Address, bigint, number, bigint, bigint, boolean, boolean,
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
    readonly [bigint, bigint, bigint, bigint, bigint, bigint], bigint, bigint,
  ];

  const [virtualInj, virtualTokens, curveSupply, graduationTarget] = params;

  // One extra call rather than a second round trip: the board already reads this and
  // the detail must agree with it, or one page names a token and the other an address.
  const symbol = await evmClient()
    .readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' })
    .catch(() => '');

  return {
    token,
    symbol,
    creator,
    lpReserve,
    rewardRoute: Number(route) === 1 ? 'pool' : 'creator',
    /*
     * Read from the curve itself, not reconstructed from the factory's constants.
     * The panel has to price against the same shape the contract trades on, and a
     * second source for these is how the two come to disagree.
     *
     * The CURRENT fees, not the configured ones: while an opening premium is
     * decaying they differ, and the figure a trader is about to pay is the current
     * one.
     */
    config: {
      virtualInj,
      virtualTokens,
      curveSupply,
      graduationTarget,
      feeBps,
      feeSellBps,
    },
    state: { injCollected, tokensSold, graduated },
    migrated,
    pool: migrated ? { quote: poolQuote, tokens: poolTokens } : null,
    platformOwed,
    creatorOwed,
    platformPaid,
    creatorPaid,
    lpBonus,
    currentFeeBps: Number(feeBps),
    currentSellFeeBps: Number(feeSellBps),
    maxPerWallet,
    tradeStart,
  };
}
