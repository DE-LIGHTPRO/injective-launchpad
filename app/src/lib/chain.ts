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
import { isDemoMode, demoLaunches, demoDetail, demoDetailByCurve, demoTrades, DEMO_HEIGHT } from './demo.ts';
import type { CurveConfig, CurveState, PoolReserves } from './curve.ts';
import type { ContractFacts } from './codeCheck.ts';

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
  /**
   * The sell fee. `#[serde(default)]` on the contract side, so a curve stored before
   * the field existed answers without it and charges nothing on exit; `?? 0` reads
   * that launch the way the chain does rather than silently substituting the buy fee.
   */
  fee_sell_bps?: number;
}

interface RawCurveContractConfig {
  denom: string;
  quote_denom: string;
  creator: string;
  platform: string;
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
  /** Optional: a curve deployed before lifetime counters existed omits them. */
  platform_paid?: string;
  creator_paid?: string;
  /** Locked-pool reserves; zero until graduation seeds them. */
  pool_quote?: string;
  pool_tokens?: string;
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
export function translateQueryError(status: number, body: string): ChainError {
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
    /*
     * PRUNED HISTORY IS NOT AN OUTAGE, and it arrives as a 500 like everything else.
     *
     * The public sentry node keeps a window of recent blocks and drops the rest, so
     * a trade older than that window answers `height N is not available, lowest
     * height is M`. Telling somebody to "try again shortly" is wrong in a way that
     * costs them time: the data is gone and retrying forever will not bring it back.
     *
     * Measured on a launch whose trades were about 83,000 blocks old, roughly
     * fifteen hours at this chain's block time. That is the real retention horizon
     * for everything built on transaction search here: trade history, fill prices,
     * candles and 24h volume.
     *
     * BUT ONE REFUSAL DOES NOT PROVE THE DATA IS GONE, and this used to say it did
     * ("the history is gone, not late"). The hostname is a load balancer, not a node:
     * probed ten times on 16 Oct 2026, sentry.lcd.injective.network answered a lowest
     * height of ~100,000 blocks back eight times and ~30,600 twice, so a query the
     * shallow node refuses the deep one serves. "Gone" is a claim about the chain made
     * from one node's answer, which is the same overstatement as reporting an
     * unreachable endpoint as an empty one. Say what was observed, and that a reload
     * may land elsewhere, without promising it will.
     */
    if (/is not available, lowest height/i.test(detail ?? '')) {
      return new ChainError(
        'These trades are older than the node that answered keeps. Reloading may reach one with more history.',
        detail,
      );
    }
    /*
     * A WRONG ADDRESS IS NOT AN OUTAGE EITHER, and it arrives as a 500 as well.
     * Measured against the mainnet sentry LCD on 16 Oct 2026:
     *
     *   the testnet factory, on mainnet  500  wasm code 22: no such contract: address inj1u35…
     *   an ordinary account              500  wasm code 22: no such contract: address inj1x33…
     *   a malformed address              500  decoding bech32 failed: invalid character …
     *
     * The 404 branch above already carries the right words for the first two, and
     * nothing could ever reach it: the LCD answers 404 for a malformed PATH, never for
     * a missing contract. So the correct message existed, was tested, and was
     * unreachable, while all three of these rendered as "The node is having trouble.
     * Try again shortly." across the whole front page.
     *
     * THIS IS A LAUNCH-MORNING FAILURE. Step 8 of the runbook sets
     * NEXT_PUBLIC_FACTORY_ADDRESS on Vercel. Leave the testnet address in place,
     * mistype a character, or set it before the deploy lands, and the site blames the
     * node and tells everyone to wait - on the same morning section 1 of the readiness
     * check is warning about this endpoint's pruning and rate limits, which is exactly
     * where somebody would then go looking. The fix is one variable.
     *
     * The chain has ANSWERED here, which is what separates these from the line below:
     * a node that could not tell us does not reply with the contract's own address. A
     * just-instantiated contract read by a lagging node is the one honest exception and
     * it lasts seconds at this block time, so the copy names the network rather than
     * claiming the contract can never exist.
     */
    if (/no such contract/i.test(detail)) {
      return new ChainError('That contract was not found on this network.', detail, true);
    }
    if (/decoding bech32 failed/i.test(detail)) {
      return new ChainError('That is not a valid Injective address.', detail, true);
    }
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

/** The factory clamps `limit` to 100, so asking for more wastes nothing and gains nothing. */
const LAUNCH_PAGE = 100;

/**
 * A bound on the loop, not on the launchpad. Hitting it THROWS rather than returning
 * a short list, because a silently truncated board is the defect this function was
 * written to fix. 5,000 launches is far past the point this page needs a different
 * shape anyway, and a loud failure is what makes that visible.
 */
const MAX_LAUNCH_PAGES = 50;

/**
 * Every launch the factory has, paged.
 *
 * IT USED TO RETURN THE OLDEST FIFTY. `Launches { start_after, limit }` ranges over
 * the id map ASCENDING and the contract clamps `limit` to 100, so a single-page read
 * returns the launches with the lowest ids and drops the newest ones. Measured
 * against the live testnet factory: `limit=2` over ids 1-4 answers `1,2`.
 *
 * Every caller here wants the whole set, and each one broke differently past fifty:
 *
 *  - `resolveLaunchSlug` matches against the list it is given, so launch 51's page
 *    would 404 at the URL the product itself generates for it. The numeric form still
 *    resolved, which means the token existed and only its own link did not work.
 *  - `launchSlug` decides whether a ticker needs its id appended by looking for a
 *    clash in that same list, so a later launch reusing an earlier ticker would be
 *    invisible to the check and `/launch/INJINU` would quietly serve the older token.
 *    `launchPath.ts` calls that "the worst available outcome" and the truncation
 *    defeated the guard written to prevent it.
 *  - `ClaimFees` lists a creator's launches to claim from: fees owed on launch 51
 *    would read as nothing to claim.
 *  - Analytics renders `rows.length` as "Launches" under a heading promising every
 *    figure is something the chain will answer for directly. It would have said 50
 *    for ever, and its "what is not here, and why" section would not have mentioned
 *    the one thing that was.
 *
 * None of this is visible below fifty launches, which is to say it arrives exactly
 * when the launchpad starts working.
 */
export async function listLaunches(): Promise<Launch[]> {
  if (isDemoMode()) return demoLaunches();
  const factory = getFactoryAddress();
  if (!factory) return [];

  const out: Launch[] = [];
  let startAfter: number | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_LAUNCH_PAGES) {
      throw new ChainError(
        'There are more launches than this page can read at once.',
        `stopped after ${MAX_LAUNCH_PAGES} pages of ${LAUNCH_PAGE}`,
      );
    }
    const res = await smartQuery<{
      launches: Array<Omit<Launch, 'profile'> & { profile?: unknown }>;
    }>(factory, { launches: { start_after: startAfter, limit: LAUNCH_PAGE } });
    /*
     * Normalised at the boundary, once. A launch created before the contract carried a
     * profile has no field at all, and a launch from a differently-configured factory may
     * carry anything; `parseProfile` turns both into nulls rather than letting one
     * malformed token throw and blank the whole list.
     */
    for (const l of res.launches) out.push({ ...l, profile: parseProfile(l.profile) });
    /*
     * A short page is the end. Asking again from the last id and getting nothing would
     * also work and costs one extra request on every board render; the contract fills a
     * page whenever it can, so a short one is the signal.
     */
    if (res.launches.length < LAUNCH_PAGE) return out;
    startAfter = res.launches[res.launches.length - 1].id;
  }
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
    feeSellBps: BigInt(raw.fee_sell_bps ?? 0),
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
  /**
   * The locked pool, once graduation has seeded it; `null` before. Nothing can
   * withdraw it, so it is the liquidity every holder exits into after graduation.
   */
  pool: PoolReserves | null;
  platformOwed: bigint;
  creatorOwed: bigint;
  /** Lifetime paid out. Zero on a curve too old to have counted. */
  platformPaid: bigint;
  creatorPaid: bigint;
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
    pool: st.migrated
      ? { quote: BigInt(st.pool_quote ?? '0'), tokens: BigInt(st.pool_tokens ?? '0') }
      : null,
    platformOwed: BigInt(st.platform_owed),
    creatorOwed: BigInt(st.creator_owed),
    /*
     * `?? '0'` rather than a throw: an older curve genuinely has no counter, and
     * zero is the honest reading of "nothing recorded" for a lifetime total. It is
     * NOT the honest reading for an owed balance, which is why only these two are
     * treated this way.
     */
    platformPaid: BigInt(st.platform_paid ?? '0'),
    creatorPaid: BigInt(st.creator_paid ?? '0'),
  };
}

/**
 * How many launch detail reads may be in flight at once.
 *
 * `getLaunchDetail` is TWO smart queries, and the factory's launch list carries no
 * curve state, so a board of N launches is 2N round trips however it is written. The
 * three places that fan it out all used a bare `Promise.all` over every launch, which
 * is unbounded: the request count is whatever the launchpad's success happens to be.
 *
 * MEASURED against `testnet.sentry.lcd.injective.network` on 16 Oct 2026, each burst a
 * single `Promise.all` of identical smart queries from one host:
 *
 *     50 concurrent     all 200                                     2,640ms
 *     200 concurrent    all 200                                     5,682ms
 *     600 concurrent    50 ok, 550 THREW UND_ERR_CONNECT_TIMEOUT   77,873ms
 *     1000 concurrent   105 ok, 895 threw                          83,531ms
 *
 * So the endpoint does not answer 429 - it drops connections, and `fetch` throws. Two
 * things make that worse than the table looks. The degradation OUTLIVES the burst:
 * after those two runs, a repeat of the 200 that had just succeeded failed 200/200,
 * and a single lone query took 11.7s against the ~160ms it costs cold. And on the
 * server every visitor's board render shares one instance's egress, so the launchpad
 * would throttle itself out of its own front page - reported, through `smartQuery`'s
 * catch, as "Could not reach mainnet".
 *
 * 16 is an order of magnitude under the observed cliff rather than a tuned figure.
 * There is no point tuning it: it bounds the damage, it does not make the shape right.
 * Past a few hundred launches this board needs the factory to return the state it
 * lists, or an index; a concurrency limit only turns "fails and blames the network"
 * into "slow". That is a better failure, not a fixed one.
 */
export const DETAIL_CONCURRENCY = 16;

/**
 * `items.map(fn)` with at most `limit` running at once, results in input order.
 *
 * Deliberately NOT a settling variant. A caller that wants to survive one item
 * failing has to say so, in its own `fn`, by catching and returning a value that says
 * the read failed - because what to do with a launch whose detail will not load is a
 * decision about that screen, and the callers here answer it differently. Hiding it
 * in here would make the rejecting case the quiet default again.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  // `Math.max(1, …)` so a misconfigured limit stalls nothing: zero workers would
  // resolve immediately with an array of holes, which reads downstream as a board
  // where every launch failed rather than as a configuration mistake.
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * Code id and admin of a contract, from the wasm module itself rather than from
 * anything the contract says about itself. `null` when it cannot be read; demo
 * launches have no contract, so they are `null` too.
 */
export async function contractFacts(address: string, denom?: string): Promise<ContractFacts | null> {
  if (isDemoMode()) return null;
  try {
    const [res, denomAdmin] = await Promise.all([
      fetch(`${getLcdUrl()}/cosmwasm/wasm/v1/contract/${address}`, {
        headers: { accept: 'application/json' },
      }),
      denom ? denomAuthority(denom) : Promise.resolve(null),
    ]);
    if (!res.ok) return null;
    const json = (await res.json()) as { contract_info?: { code_id?: string; admin?: string } };
    const info = json.contract_info;
    if (!info?.code_id) return null;
    return { codeId: String(info.code_id), admin: info.admin ?? '', denomAdmin };
  } catch {
    return null;
  }
}

/**
 * Who can mint a tokenfactory denom. Injective's route takes the creator and subdenom
 * as two path segments, not the whole `factory/...` string. `null` when unreadable,
 * including for a denom that is not a tokenfactory denom at all.
 */
export async function denomAuthority(denom: string): Promise<string | null> {
  const m = /^factory\/([^/]+)\/(.+)$/.exec(denom);
  if (!m) return null;
  try {
    const res = await fetch(
      `${getLcdUrl()}/injective/tokenfactory/v1beta1/denoms/${m[1]}/${encodeURIComponent(m[2])}/authority_metadata`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { authority_metadata?: { admin?: string } };
    return typeof json.authority_metadata?.admin === 'string' ? json.authority_metadata.admin : null;
  } catch {
    return null;
  }
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
  /**
   * Block time in UNIX seconds, or 0 when the search did not carry one.
   *
   * THE CHAIN GIVES THIS AND THIS CODE USED TO THROW IT AWAY. Every note here said
   * block height was the only ordering a trade had, so the chart bucketed by height
   * and the axis read "by block", which is unreadable on a trading surface and makes
   * timeframes impossible. `tx_responses[].timestamp` is an RFC 3339 block time and
   * has been there all along; nobody re-measured the claim. Rule: a documented
   * limitation that was never re-tested reads as a live constraint.
   *
   * It is the BLOCK's time, so every trade in a block shares it. That is correct:
   * they did happen at the same moment.
   */
  time: number;
  txHash: string;
}

/** An RFC 3339 block time as UNIX seconds, or 0 when there is not one to read. */
export function parseBlockTime(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return 0;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return 0;
  const secs = Math.floor(ms / 1000);
  // A time before the chain existed, or in the future, is not a block time. Both
  // would place a candle somewhere no trade happened.
  return secs > 1_600_000_000 && secs < Date.now() / 1000 + 86_400 ? secs : 0;
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
    time: 0,
    txHash: '',
  };
}

export async function listTrades(curve: string, limit = 20): Promise<Trade[]> {
  // Demo trades exist so the ticker and the fills chart can be looked at before a
  // real launch exists. Without them those components render on nobody's machine.
  if (isDemoMode()) return demoTrades(curve, limit);

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
      /** RFC 3339 block time, e.g. "2026-10-11T21:15:30Z". */
      timestamp?: string;
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
      /*
       * Only THIS curve's events. The search matches any transaction that touched the
       * curve, and a transaction can carry wasm events from other contracts too (a
       * router, or a second curve), whose buys would otherwise be shown here as this
       * launch's.
       */
      const addr = ev.attributes?.find((x) => x.key === '_contract_address')?.value;
      if (addr !== undefined && addr !== curve) continue;
      const t = tradeFromAttrs(ev.attributes ?? []);
      if (!t || t.kind === 'other') continue;
      out.push({
        ...t,
        height: Number(tx.height ?? 0),
        // `Date.parse` of an RFC 3339 string, in seconds. 0 when absent or
        // unparseable, never `Date.now()`: a trade dated to the moment it was read
        // would put old history at the right-hand edge of the chart.
        time: parseBlockTime(tx.timestamp),
        txHash: tx.txhash ?? '',
      });
    }
  }
  return out;
}

/*
 * `denomSupply` LIVED HERE AND NOTHING CALLED IT, and the reason to delete rather than
 * wire it is worth writing down, because the uncalled version looked like an honesty
 * check the board was missing.
 *
 * It read `bank/v1beta1/supply/by_denom` to verify a launch's real minted supply against
 * the 1B the config claims, on the theory that a denom whose admin minted more would show
 * up there and nowhere else. BUT NO ADMIN CAN. The factory hands the tokenfactory denom
 * admin to the launch's own curve contract (`MsgChangeAdmin`, `factory/src/lib.rs`), and
 * the curve has no mint path and no change-admin path at all - checked, not assumed. So
 * the supply is fixed by code the moment a launch is created, and a per-launch request
 * verifying it could only ever confirm what the wasm already guarantees. The residual
 * risk is a curve migration adding a mint, which is why the wasm admin is a multisig; a
 * supply read on the board would not catch that either, since a migration can change what
 * the launch page claims at the same time.
 *
 * Two measurements from it that are worth keeping. `supply/by_denom` does answer a
 * tokenfactory denom correctly, unlike `denom_owners` (501 on this chain) - verified
 * 3 Oct 2026, 6000000 for factory/inj100z6…/subtoken. And ZERO AND NONEXISTENT ARE THE
 * SAME ANSWER: it returns 200 with `{"amount":"0"}` for a denom that has never existed,
 * exactly as for one minted and burned entirely, so nothing may render 0 as "fully
 * burned". Rule-45 shape, in an endpoint that looks like it distinguishes them.
 */

/**
 * The chain's current block height, or null when it could not be read.
 *
 * Used only to turn a trade's height into "about 2m ago". `null` rather than a guess:
 * without it the ticker shows no age at all, which is correct, where a fabricated
 * "now" would make every trade look like it just happened.
 */
export async function currentHeight(): Promise<number | null> {
  /*
   * In demo mode this must come from the SAME clock the demo trades use.
   *
   * It did not, and the result was every row in the ticker reading "29112h": demo
   * trades sit near a fixed height while this queried the live chain at tens of
   * millions, so the difference was three years. The numbers were each plausible on
   * their own and nonsense together, which is the shape of defect a demo exists to
   * surface rather than to introduce.
   */
  if (isDemoMode()) return DEMO_HEIGHT;

  try {
    const res = await fetch(`${getLcdUrl()}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
      headers: { accept: 'application/json' },
      /*
       * The ticker is decoration on a page that must render without it, so a slow node
       * costs the age column rather than the launches.
       *
       * That used to read "a slow node delays nothing", which was a claim about the
       * CALLER that the caller did not honour: the front page awaited this after the
       * rows, so a stalling node held the whole render for the full timeout below. A
       * comment here cannot make that true - only being off the critical path can, which
       * is why `page.tsx` now reads this in the same `Promise.all` as the board.
       */
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { block?: { header?: { height?: string } } };
    const raw = json.block?.header?.height;
    return typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export interface QuoteAsset {
  denom: string;
  decimals: number;
  /**
   * Opening virtual reserve in whole units of this quote, from the factory.
   *
   * It is what sets the market cap a launch priced in this asset opens at, and it
   * belongs to the asset rather than to the launchpad: the figure that opens an INJ
   * launch at about $5,000 would open a dollar-stablecoin launch at about $630.
   * Absent on a factory that predates the field, in which case the caller falls back
   * to the default and the curve preview is the INJ one.
   */
  virtualWhole?: number;
  /** Display symbol from the factory's allowlist, when the admin set one. */
  symbol?: string;
}

/**
 * The label for a quote: the factory's symbol when it has one, otherwise a short form
 * of the denom. Prefer this to `denomLabel` wherever the allowlist is at hand, since a
 * peggy or erc20 quote is otherwise printed as a hex address.
 */
export function quoteLabel(denom: string, quotes: QuoteAsset[] | undefined): string {
  return quotes?.find((q) => q.denom === denom)?.symbol ?? denomLabel(denom);
}

/**
 * Quote assets this launchpad allows, and which one is the default.
 *
 * Read from the factory rather than configured in the app. The decimals are what
 * scale a launch's curve, so a second copy here could disagree with the contract and
 * the disagreement would show up as a graduation target out by orders of magnitude
 * rather than as an error.
 *
 * Returns the default alone when the query fails or the factory predates the
 * allowlist. That is the safe degradation: the create form then offers no choice,
 * which is what it did before this existed, rather than offering a quote the chain
 * will refuse.
 */
/** The launchpad's own one-off charge for creating a launch, read from the factory. */
export interface FactoryFee {
  amount: bigint;
  denom: string;
}

/**
 * What this launchpad charges to create a launch.
 *
 * ZERO WHEN IT CANNOT BE READ, and that is the safe direction: the create form uses
 * this to decide how much to attach, and guessing high would attach funds the
 * factory refuses as unexpected, failing a launch that would otherwise have worked.
 * An older factory has no such field and genuinely charges nothing. The chain is
 * still the authority at signing time either way.
 */
export async function factoryLaunchFee(): Promise<FactoryFee> {
  const none = { amount: 0n, denom: NETWORK.quoteDenom };
  const factory = getFactoryAddress();
  if (!factory || isDemoMode()) return none;
  try {
    const raw = await smartQuery<{ launch_fee?: unknown; launch_fee_denom?: unknown }>(
      factory,
      { config: {} },
    );
    const amount =
      typeof raw.launch_fee === 'string' && /^[0-9]+$/.test(raw.launch_fee)
        ? BigInt(raw.launch_fee)
        : 0n;
    const denom =
      typeof raw.launch_fee_denom === 'string' && raw.launch_fee_denom.length > 0
        ? raw.launch_fee_denom
        : NETWORK.quoteDenom;
    return { amount, denom };
  } catch {
    return none;
  }
}

export async function listQuotes(): Promise<{ quotes: QuoteAsset[]; defaultDenom: string }> {
  const fallback = { quotes: [{ denom: NETWORK.quoteDenom, decimals: NETWORK.quoteDecimals }], defaultDenom: NETWORK.quoteDenom };
  const factory = getFactoryAddress();
  if (!factory || isDemoMode()) return fallback;
  try {
    const raw = await smartQuery<{
      quotes?: Array<{
        denom?: unknown;
        decimals?: unknown;
        virtual_quote_whole?: unknown;
        symbol?: unknown;
      }>;
      default_denom?: unknown;
    }>(factory, { quotes: {} });
    const quotes = (raw.quotes ?? [])
      .filter((q) => typeof q.denom === 'string' && Number.isInteger(q.decimals))
      .map((q) => ({
        denom: q.denom as string,
        decimals: q.decimals as number,
        /*
         * A decimal STRING on the wire (`Uint128`), parsed here and dropped if it is
         * not a usable positive number. Dropped rather than defaulted to 0: a zero
         * opening reserve is a division by zero on the curve, and silently becoming
         * the INJ default is the behaviour this field exists to end.
         */
        ...(() => {
          const n = Number(q.virtual_quote_whole);
          return Number.isFinite(n) && n > 0 ? { virtualWhole: n } : {};
        })(),
        // Rendered as text only, never as markup, and the contract restricts it to
        // 1 to 12 letters, digits, dot or dash; re-checked so a bad value cannot spoof.
        ...(typeof q.symbol === 'string' && /^[A-Za-z0-9.-]{1,12}$/.test(q.symbol)
          ? { symbol: q.symbol }
          : {}),
      }));
    if (quotes.length === 0) return fallback;
    return {
      quotes,
      defaultDenom: typeof raw.default_denom === 'string' ? raw.default_denom : quotes[0].denom,
    };
  } catch {
    return fallback;
  }
}

/**
 * A denom, short enough to read.
 *
 * `symbolOf` handles `factory/<addr>/<SYMBOL>` and returns the tail, which is right
 * for a launched token and wrong for everything else: against
 * `erc20:0x05148C203a48103da989090CC882543eF8724f78` it returns the whole address,
 * and uppercased in a select that is 42 unreadable characters.
 *
 * NO SYMBOL IS INVENTED. An ERC20 or IBC denom's ticker is not in the string, and
 * guessing one from a registry the app does not have would be how a launchpad ends up
 * labelling an arbitrary token "USDC". The address is shortened, which is honest and
 * still identifies it.
 */
export function denomLabel(denom: string): string {
  if (denom.startsWith('factory/')) return symbolOf(denom);
  const hex = denom.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (hex) return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
  if (denom.startsWith('ibc/')) return `IBC/${denom.slice(4, 10)}…`;
  // A bare denom like "inj" is a ticker already.
  return denom.length <= 12 ? denom.toUpperCase() : `${denom.slice(0, 8)}…`;
}

/**
 * A launch's quote asset: everything needed to render an amount in it.
 *
 * ONE OBJECT RATHER THAN TWO PROPS, deliberately. `denom` and `decimals` travel
 * together through five components, and passing them separately is how one of them
 * gets missed: a figure scaled correctly and labelled wrongly, or the reverse, looks
 * plausible on screen either way. Bundled, a component either has the quote or it
 * does not.
 */
export interface Quote {
  denom: string;
  decimals: number;
  /** Short, readable form for putting beside a number. */
  label: string;
  /** This asset's opening virtual reserve, in whole units. See `QuoteAsset`. */
  virtualWhole?: number;
}

/**
 * A launch's quote, including the decimals that scale every figure shown in it, picked
 * from an allowlist already in hand.
 *
 * The decimals come from the factory's allowlist, which is the same source the
 * contract scaled the launch's curve with. Falling back to the network default is
 * right for a factory that predates the allowlist, where every launch really was in
 * the default quote.
 *
 * SEPARATE FROM THE READ because the read is one request for the whole board and the
 * pick is per launch, and conflating them cost one identical request per launch. See
 * `resolveQuote` below. This is not a second resolver: it is the resolver, with the
 * fetch hoisted out of it, and `resolveQuote` is the one-denom convenience over it.
 */
export function quoteFromList(denom: string, quotes: QuoteAsset[]): Quote {
  const found = quotes.find((q) => q.denom === denom);
  return {
    denom,
    decimals: found?.decimals ?? NETWORK.quoteDecimals,
    label: quoteLabel(denom, quotes),
    ...(found?.virtualWhole !== undefined ? { virtualWhole: found.virtualWhole } : {}),
  };
}

/**
 * The same thing for a caller that holds only a denom, at the cost of a request.
 *
 * ONE DENOM, ONE READ: do not call this inside a loop or a fan-out. The allowlist is
 * the same list for every launch on the board, so N launches meant N byte-identical
 * `quotes {}` queries to the same contract. `ClaimFees` did exactly that inside its
 * per-launch fan-out, which made a third of a creator's requests pure duplication, and
 * the comment above it reported "three requests per launch" as the intended cost.
 * Read the list once and call `quoteFromList` per launch.
 */
export async function resolveQuote(denom: string): Promise<Quote> {
  const { quotes } = await listQuotes();
  return quoteFromList(denom, quotes);
}
