/**
 * Trade history on the EVM backend, from the curve's own event logs.
 *
 * WHAT WAS ON THE SCREEN. The launch page's Trades tab read "That contract was not
 * found on this network." - a CosmWasm transaction-search error, translated, on an EVM
 * page about a contract that is plainly on this network. `listTrades` builds a
 * `/cosmos/tx/v1beta1/txs` query and sends it to a JSON-RPC host, which answers with
 * something that gets read as a missing contract. The sentence under it was honest
 * ("the curve's own state says this launch has traded; what could not be read is the
 * record of those trades") and the sentence above it was not.
 *
 * THE RANGE CAP IS THE WHOLE DESIGN CONSTRAINT, AND IT IS MEASURED.
 * `sentry.evm-rpc.injective.network`, 30 Oct 2026:
 *
 *     span 1       0 logs            span 100,000    ERROR -32000
 *     span 1,000   0 logs            span 1,000,000  ERROR -32000
 *     span 10,000  0 logs            from genesis    ERROR -32000
 *
 *     maximum [from, to] blocks distance: 10000
 *
 * Ten thousand blocks, hard. Injective blocks are sub-second, so one page is under
 * two hours of chain time and the head was block 189,510,320. A launch created two
 * days ago is ~270,000 blocks back: twenty-seven requests. A launch from last month
 * is four hundred. So SCANNING CANNOT REBUILD A FULL HISTORY, and a page that implied
 * it had one would be lying by omission the moment a launch got old.
 *
 * WHAT IT DOES INSTEAD: pages back from the head, newest first, stopping as soon as it
 * has enough trades or hits its page budget. It reads TWO windows - one at the head
 * and one at the launch's creation - because a bonding curve's trades are in both
 * places and the distance between them is too far to walk; see `HEAD_PAGES` for the
 * measurement that established this. The result carries both windows and a `complete`
 * flag, so the UI says which blocks it read rather than presenting a prefix as the
 * whole thing - the partial-read-as-absence distinction this project has got wrong
 * before.
 *
 * The CosmWasm side has the same problem for a different reason (a transaction index
 * that reaches back about sixteen hours) and solves it with deeper fallback endpoints.
 * There is no equivalent here: the cap is a policy on the method, not a retention
 * floor, so a second host would have the same cap.
 */
import { parseEventLogs, type Address, type Log } from 'viem';

import type { Trade } from '../chain.ts';
import { CURVE_ABI } from './abi.ts';
import { evmClient } from './read.ts';

/**
 * The endpoint's hard limit on `eth_getLogs`, measured rather than assumed.
 *
 * Asking for more returns `-32000 maximum [from, to] blocks distance: 10000`, which
 * is a refusal and not a truncation: there is no partial answer to salvage.
 */
/**
 * The slice of the chain this file uses, injectable so the WINDOW ARITHMETIC can be
 * exercised without 26 round trips to a live node.
 *
 * A DEFAULTED PARAMETER, NOT A MODULE SWAP. The first test tried
 * `Object.defineProperty(read, 'evmClient', …)` and got "Cannot redefine property":
 * ESM exports are not writable, so there is no seam to be had from outside. The same
 * answer `executeManyEvm` already uses for its executor - and the thing worth testing
 * here is which block ranges get asked for, which is invisible from the result.
 */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(a: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export const LOG_RANGE_CAP = 10_000n;

/**
 * Pages read back from the head, and pages read forward from the launch's creation.
 *
 * TWO WINDOWS, BECAUSE THE TRADES ARE IN TWO PLACES AND THE CHAIN IS TOO BIG TO WALK.
 * Measured against the live PAD launch on 30 Oct 2026:
 *
 *     created          2026-10-28T10:54:49Z
 *     creation block   189,280,751   (resolved in 478ms)
 *     head             189,537,569
 *     distance         256,818 blocks = 26 pages
 *     one page         ~250ms
 *     logs in the page immediately after creation:   1
 *     logs in the page immediately before the head:  0
 *
 * So walking the whole distance is twenty-six requests and six seconds for one page
 * of a feed, and the first version did exactly that: twelve pages back from the head,
 * found nothing, and reported zero trades for a launch whose own state says it has
 * traded. The trade was 256,000 blocks away, in the page right after it was created.
 *
 * That is not an accident of this launch, it is what a bonding curve does. The opening
 * fills happen when the launch is announced, and a quiet launch's entire history is
 * the first page after its birth. An ACTIVE launch's newest fills are near the head.
 * Reading both windows costs six requests, finds the opening of a quiet launch and
 * the recent fills of a busy one, and is honest about the gap between them.
 *
 * Three pages each: 30,000 blocks is about five hours of this chain either side.
 */
export const HEAD_PAGES = 3;
export const BIRTH_PAGES = 3;

/**
 * How many probes the creation-block search is allowed.
 *
 * Each one is a `getBlock`, and the search halves its error every time, so six is
 * ample for a chain 189 million blocks deep: the first estimate is already within a
 * few thousand and each step walks a measured stride back. A bound rather than a
 * target - it usually lands in two.
 */
const BIRTH_PROBES = 10;

/**
 * A block AT OR BEFORE a given timestamp, established by reading block timestamps.
 *
 * WHY NOT JUST DIVIDE. The factory records a launch's creation as a unix timestamp,
 * and the scan needs a block number to floor at. The arithmetic - head minus elapsed
 * seconds over block time - is an estimate, and this project's rule is that an
 * estimate must not be dressed as a measurement. The estimate is fine as a PLACE TO
 * LOOK; what it cannot do is support the `complete` claim, because "I scanned back to
 * the launch's creation" would then rest on an assumed block time.
 *
 * So the estimate opens the search and a measured timestamp closes it: this returns a
 * block whose own `timestamp` the node reported as at or before the target, which is
 * a fact about that block. Walking BACKWARDS only, never forwards, so the answer is
 * always on the safe side - a floor slightly too low costs one extra page of logs, a
 * floor too high silently drops the oldest trades.
 *
 * `null` when it cannot be established in the budget, and the caller then reports a
 * window instead of a history. Not a fallback to the estimate: that is the whole point.
 */
export async function blockAtOrBefore(
  targetSeconds: number,
  head: bigint,
  client: ChainReader = evmClient(),
): Promise<bigint | null> {
  let headTime: number;
  try {
    headTime = Number((await client.getBlock({ blockNumber: head })).timestamp);
  } catch {
    return null;
  }
  if (targetSeconds >= headTime) return head;

  /*
   * The stride is derived from TWO MEASURED BLOCKS rather than from a constant block
   * time, so a chain that changes its cadence does not quietly break the search.
   * `head - 10000` is one log page back, which is far enough to average out jitter and
   * near enough to be a current rate.
   */
  const probeBack = head > LOG_RANGE_CAP ? head - LOG_RANGE_CAP : 0n;
  let secondsPerBlock = 1;
  try {
    const t = Number((await client.getBlock({ blockNumber: probeBack })).timestamp);
    const span = Number(head - probeBack);
    if (span > 0 && headTime > t) secondsPerBlock = (headTime - t) / span;
  } catch {
    return null;
  }
  if (!(secondsPerBlock > 0)) return null;

  let guess = head - BigInt(Math.ceil((headTime - targetSeconds) / secondsPerBlock));
  if (guess < 0n) guess = 0n;

  /*
   * AN EXPONENTIAL WALK BACK, not a repeated linear correction, and the difference is
   * whether this terminates inside its budget.
   *
   * The stride is measured from two RECENT blocks, so if the chain has changed pace it
   * is wrong by a factor for an older target - and a step of `(t - target) / stride`
   * is then short by that same factor every time. Found by a test fixture whose recent
   * blocks ran four times slower than its old ones: the correction converged with a
   * ratio of about three quarters per probe, needing roughly eighteen to cross a
   * 225,000-block error, and this returned null after six. On the live chain it landed
   * in one, which is exactly why a fixture had to make the estimate wrong on purpose.
   *
   * So each probe steps back by the linear estimate TIMES A DOUBLING FACTOR, which
   * crosses any constant factor of stride error in two or three steps. Overshooting
   * backwards is free, because the contract is "at or before" - a block earlier than
   * the launch costs one extra page of logs and is still a correct floor.
   *
   * THE FACTOR GOES ON THE STEP, NOT ON THE STRIDE, which I got backwards first. The
   * step is `elapsed / stride`, so doubling the stride HALVES the step: traced against
   * the fixture it converged with a ratio of about 0.6 per probe and was still 130,000
   * blocks short after ten. Printing the ten guesses is what showed it; the direction
   * of a correction is not something to reason about twice.
   */
  for (let i = 0; i < BIRTH_PROBES; i++) {
    let t: number;
    try {
      t = Number((await client.getBlock({ blockNumber: guess })).timestamp);
    } catch {
      return null;
    }
    // MEASURED, so the claim this supports is measured too.
    if (t <= targetSeconds) return guess;
    if (guess === 0n) return 0n;
    const linear = Math.max(1, Math.ceil((t - targetSeconds) / secondsPerBlock));
    const back = BigInt(linear) * (1n << BigInt(i));
    guess = guess > back ? guess - back : 0n;
  }
  return null;
}

export interface EvmTradeHistory {
  trades: Trade[];
  /** The oldest block the window at the head reached. */
  scannedFrom: number;
  head: number;
  /** The window read at the launch's creation, when one was read. */
  openingWindow: { from: number; to: number } | null;
  /**
   * True only when every block since the launch was created has been read.
   *
   * THE FIELD THAT KEEPS THE UI HONEST. Without it a prefix and a complete history are
   * the same array, and a reader cannot tell a launch with three trades from one whose
   * first fifty are outside both windows. True when the two windows meet, so there is
   * no gap; false when there is one; `null` when the creation block could not be
   * established, which is a third answer and not a `false`.
   */
  complete: boolean | null;
}

/** Which event names on the curve are trades, and what kind each is. */
const KINDS: Record<string, Trade['kind']> = {
  Bought: 'buy',
  Sold: 'sell',
  PoolBought: 'buy',
  PoolSold: 'sell',
  Graduated: 'graduate',
};

type Decoded = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber?: bigint;
  transactionHash?: string | null;
  logIndex?: number;
};

function big(v: unknown): bigint | null {
  return typeof v === 'bigint' ? v : null;
}

/**
 * One decoded log as the `Trade` the rest of the app already consumes.
 *
 * THE SEAM IS THE TYPE, as everywhere else under `evm/`: the ticker, the fills chart,
 * `quoteMoved` and the volume totals all read `Trade`, which says nothing about which
 * chain produced it. The field names differ between the two sides (`injIn`/`tokens`
 * here against the CosmWasm attributes) and that translation belongs in one place.
 *
 * `time` IS LEFT AS THE BLOCK'S TIMESTAMP, FETCHED SEPARATELY. A log carries no time,
 * and the chart buckets by it: `0` would stack every trade at the epoch. See
 * `withBlockTimes`.
 */
function toTrade(d: Decoded): Trade | null {
  const kind = KINDS[d.eventName];
  if (!kind) return null;
  const a = d.args;
  return {
    kind,
    who: typeof a.buyer === 'string' ? a.buyer : typeof a.seller === 'string' ? a.seller : null,
    injIn: big(a.injIn),
    injOut: big(a.injOut),
    tokens: big(a.tokensOut) ?? big(a.tokensIn),
    fee: big(a.fee),
    /*
     * `Bought` carries a refund on the buy that empties the curve; `Sold` and the pool
     * events have no such field, and `null` is how this says "the event carried none"
     * rather than "nothing was refunded". `quoteMoved` depends on that distinction.
     */
    refund: big(a.refund),
    height: Number(d.blockNumber ?? 0n),
    time: 0,
    txHash: typeof d.transactionHash === 'string' ? d.transactionHash : '',
  };
}

/**
 * Fill in each trade's block time.
 *
 * ONE REQUEST PER DISTINCT BLOCK, not per trade: several fills in one block share a
 * timestamp, and they genuinely happened at the same moment - the same reasoning the
 * CosmWasm side records for `tx_responses[].timestamp`. A busy launch puts many trades
 * in few blocks, so this is usually a handful of requests.
 *
 * A BLOCK THAT CANNOT BE READ LEAVES `time` AT 0 rather than guessing from its
 * neighbours. The chart drops a zero-timed fill; an interpolated one would put a trade
 * at a moment nothing measured, which is the chart-data rule.
 */
async function withBlockTimes(trades: Trade[], client: ChainReader): Promise<Trade[]> {
  const blocks = [...new Set(trades.map((t) => t.height))].filter((h) => h > 0);
  if (blocks.length === 0) return trades;

  const times = new Map<number, number>();
  await Promise.all(
    blocks.map(async (h) => {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(h) });
        times.set(h, Number(b.timestamp));
      } catch {
        /* left out of the map, so `time` stays 0 */
      }
    }),
  );
  return trades.map((t) => ({ ...t, time: times.get(t.height) ?? 0 }));
}

/**
 * Read one window of blocks as trades, newest first.
 *
 * A REFUSED PAGE STOPS THE WALK and keeps what came before it, rather than skipping to
 * the next one. Skipping would leave a hole in the middle of a list presented as
 * contiguous, which is worse than a shorter list: a reader can see that a window is
 * short and cannot see that it has a gap. Returns how far it actually got, so the
 * caller reports the window it read rather than the one it asked for.
 */
async function scanWindow(
  client: ChainReader,
  curve: Address,
  from: bigint,
  to: bigint,
  limit: number,
): Promise<{ trades: Trade[]; reachedFrom: bigint }> {
  const found: Trade[] = [];
  let cursor = to;
  let reachedFrom = to;

  while (cursor >= from) {
    const pageFrom = cursor - LOG_RANGE_CAP + 1n > from ? cursor - LOG_RANGE_CAP + 1n : from;
    let logs: Log[];
    try {
      logs = await client.getLogs({ address: curve, fromBlock: pageFrom, toBlock: cursor });
    } catch {
      break;
    }
    reachedFrom = pageFrom;

    const decoded = parseEventLogs({ abi: CURVE_ABI, logs }) as unknown as Decoded[];
    // Newest first within the page: `getLogs` does not promise an order.
    decoded.sort(
      (a, b) =>
        Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)) ||
        (b.logIndex ?? 0) - (a.logIndex ?? 0),
    );
    for (const d of decoded) {
      const t = toTrade(d);
      if (t) found.push(t);
    }

    if (found.length >= limit) break;
    if (pageFrom === from) break;
    cursor = pageFrom - 1n;
  }

  return { trades: found, reachedFrom };
}

/**
 * The curve's trades, newest first, over the window at the head and the window at the
 * launch's creation.
 *
 * @param createdAtBlock the launch's creation block when it has been established by
 *   `blockAtOrBefore`. Without it only the head window is read and `complete` is null,
 *   which the UI must not render as "that is all of them".
 */
export async function listTradesEvm(
  curve: string,
  limit = 20,
  createdAtBlock?: number,
  client: ChainReader = evmClient(),
): Promise<EvmTradeHistory> {
  const head = await client.getBlockNumber();
  const addr = curve as Address;

  const birth =
    createdAtBlock !== undefined && createdAtBlock > 0 ? BigInt(createdAtBlock) : null;

  const headSpan = LOG_RANGE_CAP * BigInt(HEAD_PAGES);
  let headFloor = head > headSpan ? head - headSpan + 1n : 0n;
  /*
   * A launch born INSIDE the head window needs no second read: one contiguous walk
   * covers everything, and flooring at its birth saves reading blocks from before it
   * existed - which is also what makes `complete` true below.
   */
  if (birth !== null && birth > headFloor) headFloor = birth;

  const recent = await scanWindow(client, addr, headFloor, head, limit);
  const trades = [...recent.trades];
  let openingWindow: { from: number; to: number } | null = null;

  /*
   * THE SECOND WINDOW, and the measurement that made it necessary: PAD's only trade
   * was 256,000 blocks from the head, in the page immediately after it was created,
   * and a head-only scan reported zero trades for a launch whose own state says it has
   * traded. Read only when it is a different window and the first one did not already
   * answer - so an active launch pays for one walk and a quiet one for two.
   */
  const contiguous = birth !== null && recent.reachedFrom <= birth;
  if (birth !== null && !contiguous && trades.length < limit) {
    const birthTop = birth + LOG_RANGE_CAP * BigInt(BIRTH_PAGES) - 1n;
    const top = birthTop < recent.reachedFrom - 1n ? birthTop : recent.reachedFrom - 1n;
    if (top >= birth) {
      const opening = await scanWindow(client, addr, birth, top, limit - trades.length);
      trades.push(...opening.trades);
      openingWindow = { from: Number(opening.reachedFrom), to: Number(top) };
    }
  }

  /*
   * Newest first ACROSS both windows. The head window's trades are all above the
   * opening window's, so concatenation is already ordered - sorted anyway, because
   * relying on that is relying on the two windows never being reordered or merged,
   * which is the kind of assumption that holds until someone changes the budgets.
   */
  trades.sort((a, b) => b.height - a.height);

  /*
   * `complete` IS A CLAIM ABOUT COVERAGE, not about how many trades came back. True
   * only when every block since the launch existed has been read: either the head walk
   * reached the birth, or the opening window ran up to where the head walk stopped.
   */
  const complete =
    birth === null
      ? null
      : contiguous ||
        (openingWindow !== null &&
          BigInt(openingWindow.from) <= birth &&
          BigInt(openingWindow.to) >= recent.reachedFrom - 1n);

  return {
    trades: await withBlockTimes(trades.slice(0, limit), client),
    scannedFrom: Number(recent.reachedFrom),
    head: Number(head),
    openingWindow,
    complete,
  };
}
