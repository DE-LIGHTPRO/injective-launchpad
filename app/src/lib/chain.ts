/**
 * Read-only chain access over the LCD endpoint.
 *
 * CosmWasm smart queries are plain HTTP: base64 the query JSON onto the
 * contract's smart-query path. That keeps the read path free of any SDK, so
 * browsing launches works before a wallet is ever connected.
 *
 * Signing is a different matter and lives in `wallet.ts`.
 */

import { NETWORK, getLcdUrl, getFactoryAddress } from './config';
import { isDemoMode, demoLaunches, demoDetail, demoDetailByCurve } from './demo';
import type { CurveConfig, CurveState } from './curve';

/** Shape stored by the factory for each launch. */
export interface Launch {
  id: number;
  denom: string;
  creator: string;
  curve: string;
}

/** Raw curve config as the contract stores it, all amounts as strings. */
interface RawCurveConfig {
  virtual_inj: string;
  virtual_tokens: string;
  curve_supply: string;
  graduation_target: string;
  fee_bps: number;
}

interface RawCurveContractConfig {
  denom: string;
  quote_denom: string;
  creator: string;
  platform: string;
  migration_target: string;
  lp_reserve: string;
  creator_fee_share_bps: number;
  curve: RawCurveConfig;
}

interface RawCurveState {
  inj_collected: string;
  tokens_sold: string;
  graduated: boolean;
  migrated: boolean;
  platform_owed: string;
  creator_owed: string;
}

export class ChainError extends Error {
  /** The underlying detail, for logs and dev builds only. */
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'ChainError';
    this.detail = detail;
  }
}

/**
 * Turn an upstream failure into something a user can act on.
 *
 * Sealed's rule: raw provider errors are written for integrators, leak
 * internals, and tell a trader nothing. The original is kept on `detail` so a
 * dev build and the console still have it.
 */
function translateQueryError(status: number, body: string): ChainError {
  const detail = `${status}: ${body.slice(0, 300)}`;
  if (status === 404) {
    return new ChainError('That contract was not found on this network.', detail);
  }
  if (status === 400 && /not found|unknown request|parse/i.test(body)) {
    return new ChainError(
      'This launch could not be read. It may have been created by a different version of the contracts.',
      detail,
    );
  }
  if (status === 429) {
    return new ChainError('The network is rate limiting us. Try again shortly.', detail);
  }
  if (status >= 500) {
    return new ChainError('The node is having trouble. Try again shortly.', detail);
  }
  return new ChainError('Could not read from the network.', detail);
}

/** Run a CosmWasm smart query against a contract. */
export async function smartQuery<T>(contract: string, query: unknown): Promise<T> {
  const encoded = btoa(JSON.stringify(query));
  const url = `${getLcdUrl()}/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ChainError(
      `Could not reach ${NETWORK.name}. Check your connection and try again.`,
      (e as Error).message,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw translateQueryError(res.status, body);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

export async function listLaunches(limit = 50): Promise<Launch[]> {
  if (isDemoMode()) return demoLaunches().slice(0, limit);
  const factory = getFactoryAddress();
  if (!factory) return [];
  const res = await smartQuery<{ launches: Launch[] }>(factory, { launches: { limit } });
  return res.launches;
}

export async function getLaunch(id: number): Promise<Launch> {
  if (isDemoMode()) {
    const found = demoLaunches().find((l) => l.id === id);
    if (!found) throw new ChainError('No such launch.');
    return found;
  }
  const factory = getFactoryAddress();
  if (!factory) throw new ChainError('This launchpad is not available yet.');
  return smartQuery<Launch>(factory, { launch: { id } });
}

function toCurveConfig(raw: RawCurveConfig): CurveConfig {
  return {
    virtualInj: BigInt(raw.virtual_inj),
    virtualTokens: BigInt(raw.virtual_tokens),
    curveSupply: BigInt(raw.curve_supply),
    graduationTarget: BigInt(raw.graduation_target),
    feeBps: BigInt(raw.fee_bps),
  };
}

export interface LaunchDetail {
  denom: string;
  quoteDenom: string;
  creator: string;
  lpReserve: bigint;
  config: CurveConfig;
  state: CurveState;
  migrated: boolean;
  platformOwed: bigint;
  creatorOwed: bigint;
}

/** Everything the trade panel needs, in one place and already in bigint. */
export async function getLaunchDetail(curveAddress: string): Promise<LaunchDetail> {
  if (isDemoMode()) {
    const d = demoDetailByCurve(curveAddress);
    if (!d) throw new ChainError('No such launch.');
    return d;
  }
  const [cfg, st] = await Promise.all([
    smartQuery<RawCurveContractConfig>(curveAddress, { config: {} }),
    smartQuery<RawCurveState>(curveAddress, { state: {} }),
  ]);

  return {
    denom: cfg.denom,
    quoteDenom: cfg.quote_denom,
    creator: cfg.creator,
    lpReserve: BigInt(cfg.lp_reserve),
    config: toCurveConfig(cfg.curve),
    state: {
      injCollected: BigInt(st.inj_collected),
      tokensSold: BigInt(st.tokens_sold),
      graduated: st.graduated,
    },
    migrated: st.migrated,
    platformOwed: BigInt(st.platform_owed),
    creatorOwed: BigInt(st.creator_owed),
  };
}

/** Short display form for an address. */
export function short(addr: string, keep = 6): string {
  if (addr.length <= keep * 2 + 3) return addr;
  return `${addr.slice(0, keep)}…${addr.slice(-keep)}`;
}

/** A token denom's display symbol, pulled from the tokenfactory subdenom. */
export function symbolOf(denom: string): string {
  const parts = denom.split('/');
  return (parts[parts.length - 1] || denom).toUpperCase();
}
