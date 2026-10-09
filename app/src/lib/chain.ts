/**
 * Read-only chain access over the LCD endpoint.
 *
 * CosmWasm smart queries are plain HTTP: base64 the query JSON onto the
 * contract's smart-query path. That keeps the read path free of any SDK, so
 * browsing launches works before a wallet is ever connected.
 *
 * Signing is a different matter and lives in `wallet.ts`.
 */

import { parseProfile, type TokenProfile } from './tokenProfile.ts';
import { parseRules, type LaunchRules } from './launchRules.ts';

/** Nanoseconds as a string, as CosmWasm sends a `Timestamp`, to whole seconds. */
function openedAtSeconds(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  try {
    return Number(BigInt(raw) / 1_000_000_000n);
  } catch {
    return null;
  }
}
import { NETWORK, getLcdUrl, getFactoryAddress } from './config.ts';
import { isDemoMode, demoLaunches, demoDetail, demoDetailByCurve } from './demo.ts';
import type { CurveConfig, CurveState } from './curve.ts';

/** Shape stored by the factory for each launch. */
export interface Launch {
  id: number;
  denom: string;
  creator: string;
  curve: string;
  /*
   * Always present after `parseProfile`, even for a launch created before the contract
   * carried the field, so nothing downstream has to test for its absence. The values
   * inside it are still untrusted: they came from whoever created the launch, and every
   * render site passes them through `safeExternalUrl` first.
   */
  profile: TokenProfile;
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
  /**
   * True when the thing asked for does not exist, as opposed to not being reachable.
   *
   * The distinction decides an HTTP STATUS, which is why it is a flag rather than a
   * message anyone can match on. A missing launch rendered the error inline and
   * answered 200, so every wrong id in a URL told crawlers and link checkers that a
   * real page lived there. "The chain is unreachable" must not do the same: that page
   * exists and will work again in a minute, and answering 404 for it would have search
   * engines drop real launches during an outage.
   */
  readonly notFound: boolean;
  constructor(message: string, detail?: string, notFound = false) {
    super(message);
    this.name = 'ChainError';
    this.detail = detail;
    this.notFound = notFound;
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
  const res = await smartQuery<{ launches: Array<Omit<Launch, 'profile'> & { profile?: unknown }> }>(
    factory,
    { launches: { limit } },
  );
  /*
   * Normalised at the boundary, once. A launch created before the contract carried a
   * profile has no field at all, and a launch from a differently-configured factory may
   * carry anything; `parseProfile` turns both into nulls rather than letting one
   * malformed token throw and blank the whole list.
   */
  return res.launches.map((l) => ({ ...l, profile: parseProfile(l.profile) }));
}

export async function getLaunch(id: number): Promise<Launch> {
  if (isDemoMode()) {
    const found = demoLaunches().find((l) => l.id === id);
    if (!found) throw new ChainError('No such launch.', undefined, true);
    return found;
  }
  const factory = getFactoryAddress();
  if (!factory) throw new ChainError('This launchpad is not available yet.');
  const raw = await smartQuery<Omit<Launch, 'profile'> & { profile?: unknown }>(factory, {
    launch: { id },
  });
  // Normalised here too. The list path and the single path are two doors into the same
  // data, and a field cleaned at one of them is the shape of defect this project keeps
  // finding: both sides locally correct, inconsistent together.
  return { ...raw, profile: parseProfile(raw.profile) };
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
  /** Normalised; `NO_RULES` for a launch that has none. */
  rules: LaunchRules;
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
    /*
     * `opened_at` comes from the contract rather than being inferred. A launch with no
     * start time opened at the block that created it, which this side has no way to
     * know, and guessing "now" would make the decay restart on every page load: a
     * premium that never ends, displayed as one that is always just beginning.
     *
     * CosmWasm sends it as nanoseconds, same as `trade_start`.
     */
    rules: parseRules(
      (cfg as { rules?: unknown }).rules,
      openedAtSeconds((cfg as { opened_at?: unknown }).opened_at),
    ),
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

// ---------------------------------------------------------------------------
// Holders: NOT AVAILABLE, and this note exists so nobody spends the hour again.
//
// Every launchpad shows a holder list, and it is the one panel that is a safety
// signal rather than a convenience: a launch whose supply sits in two wallets is
// a different proposition from one spread across two hundred.
//
// It cannot be built from any public endpoint. Measured on Injective testnet,
// 3 Oct 2026:
//
//   /cosmos/bank/v1beta1/denom_owners/inj                      200, real holders
//   /cosmos/bank/v1beta1/denom_owners/factory%2F…%2Fsubtoken   501 Not Implemented
//
// 501 for a real tokenfactory denom, tested against three of the 265 that exist
// on testnet, which is exactly the set a launchpad needs. The explorer's
// api/explorer/v1 paths serve the HTML single-page app rather than JSON, so there
// is no public indexer to fall back to either.
//
// A panel built on that endpoint would have rendered "no holders" for every
// launched token, which reads as a token nobody owns rather than as a gap in the
// chain's REST surface. That is why this is a comment and not a function.
//
// What IS available and is used below: supply by denom, tx search by contract,
// and denoms_from_creator for a creator's launches. Holders need a self-hosted
// indexer over bank transfer events.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trades
//
// Read from transaction events rather than from contract state, because the
// contract deliberately stores no history: a launch keeps its position, not its
// past, and paying storage for a feed nobody settles against would be the wrong
// trade. `query=wasm._contract_address='…'` is a standard Cosmos tx search and
// needs no indexer. Verified against Injective testnet on 3 Oct 2026, including
// that an unknown contract answers `{"txs":[],"total":"0"}` rather than erroring.
// ---------------------------------------------------------------------------

export interface Trade {
  kind: 'buy' | 'sell' | 'graduate' | 'other';
  /** The trader, from the contract's own attribute rather than the tx sender. */
  who: string | null;
  /** Base units, as the contract emitted them. */
  injIn: bigint | null;
  injOut: bigint | null;
  tokens: bigint | null;
  fee: bigint | null;
  height: number;
  txHash: string;
}

/** The attribute set each handler emits, read back off the event log. */
function tradeFromAttrs(attrs: Array<{ key: string; value: string }>): Trade | null {
  const at = (k: string): string | undefined => attrs.find((a) => a.key === k)?.value;
  const action = at('action');
  if (!action) return null;
  const big = (k: string): bigint | null => {
    const v = at(k);
    return v !== undefined && /^[0-9]+$/.test(v) ? BigInt(v) : null;
  };
  const kind: Trade['kind'] =
    action === 'buy' ? 'buy' : action === 'sell' ? 'sell' : action === 'graduate' ? 'graduate' : 'other';
  return {
    kind,
    who: at('buyer') ?? at('seller') ?? null,
    injIn: big('inj_in'),
    injOut: big('inj_out'),
    tokens: big('tokens_out') ?? big('tokens_in'),
    fee: big('fee'),
    height: 0,
    txHash: '',
  };
}

export async function listTrades(curve: string, limit = 20): Promise<Trade[]> {
  const q = encodeURIComponent(`wasm._contract_address='${curve}'`);
  const url = `${getLcdUrl()}/cosmos/tx/v1beta1/txs?query=${q}&limit=${limit}&order_by=ORDER_BY_DESC`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ChainError(`Could not reach ${NETWORK.name} to read trades.`, (e as Error).message);
  }
  if (!res.ok) throw translateQueryError(res.status, await res.text().catch(() => ''));

  const json = (await res.json()) as {
    tx_responses?: Array<{
      txhash?: string;
      height?: string;
      code?: number;
      events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
    }>;
    code?: number;
    message?: string;
  };
  /*
   * This endpoint answers a malformed query with HTTP 200 and an error document,
   * which is how it was first mistaken for a working call. The error shape is
   * checked before the result shape.
   */
  if (typeof json.code === 'number' && json.message) {
    throw new ChainError('That trade query was refused by the network.', json.message);
  }
  if (!Array.isArray(json.tx_responses)) {
    throw new ChainError('The network answered with something that was not a transaction list.');
  }

  const out: Trade[] = [];
  for (const tx of json.tx_responses) {
    // A reverted transaction is not a trade. Including failures would show a feed
    // of activity that never moved anything.
    if (tx.code && tx.code !== 0) continue;
    for (const ev of tx.events ?? []) {
      if (ev.type !== 'wasm') continue;
      const t = tradeFromAttrs(ev.attributes ?? []);
      if (!t || t.kind === 'other') continue;
      out.push({ ...t, height: Number(tx.height ?? 0), txHash: tx.txhash ?? '' });
    }
  }
  return out;
}

/**
 * Real minted supply for a denom, from the bank module.
 *
 * Worth reading rather than trusting the launch config, because the two can
 * disagree and only one of them is what exists: the config says what the curve
 * was told to sell, and this says what was actually minted. A launch seeded with
 * the wrong amount, or a denom whose admin minted more afterwards, shows up here
 * and nowhere else on the page.
 *
 * `supply/by_denom` answers a tokenfactory denom correctly, unlike
 * `denom_owners` above. Verified against a live testnet factory denom on
 * 3 Oct 2026: 6000000 for factory/inj100z6…/subtoken.
 *
 * ZERO AND NONEXISTENT ARE THE SAME ANSWER HERE, and the docstring said otherwise
 * until it was checked. This endpoint returns HTTP 200 with `{"amount":"0"}` for a
 * denom that has never existed, exactly as it would for one minted and then burned
 * entirely, so the distinction cannot be recovered from this call. Callers must not
 * render 0 as "fully burned". `null` is returned only when the body is not a supply
 * at all, which is a different thing again: the network did not answer the question.
 */
export async function denomSupply(denom: string): Promise<bigint | null> {
  const url = `${getLcdUrl()}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ChainError(`Could not reach ${NETWORK.name} to read supply.`, (e as Error).message);
  }
  // Kept for other nodes: this one answers 200 with "0" instead, which is why the
  // note above is explicit that 0 cannot be read as "burned".
  if (res.status === 404) return null;
  if (!res.ok) throw translateQueryError(res.status, await res.text().catch(() => ''));

  const json = (await res.json()) as { amount?: { denom?: string; amount?: string } };
  const raw = json.amount?.amount;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  return BigInt(raw);
}
