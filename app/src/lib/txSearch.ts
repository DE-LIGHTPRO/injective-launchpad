import { getHistoryEndpoints, NETWORK } from './config.ts';
import { probeServedChainId } from './chainMatch.ts';

/**
 * Transaction search, across more than one endpoint.
 *
 * WHY THIS EXISTS. Everything historical in this product - the candle chart, the trade
 * feed, the trade count, 24h volume - is built on `/cosmos/tx/v1beta1/txs`, and the
 * default endpoint's transaction index reaches back about 16 hours. Measured 25 Oct
 * 2026: `sentry.lcd.injective.network` kept 100,004 blocks where 24h volume needs
 * 132,923. That figure is not stale on that host, it is unobtainable, from the first
 * hour of the product's life. Audit F-04.
 *
 * The remedy is not a purchase. Endpoints with far deeper indexes answer for free -
 * `injective-rest.publicnode.com` held about 18 days on the shallower of its two nodes
 * - so a refusal from the primary is worth asking somebody else about before it becomes
 * an empty chart. See `historyFallbacks` for what was measured and what was not.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 *  - It does not spread load. The configured endpoint is always tried first and the
 *    rest exist only for when it cannot answer. An operator who has paid for an
 *    archival endpoint should not be quietly sending a share of their reads elsewhere.
 *  - It does not turn a refusal into an absence. If every endpoint refuses, the
 *    refusal is thrown, and `translateQueryError` turns a pruning 500 into a sentence
 *    about a window rather than "no trades". A launch reading as dead when it is alive
 *    is the harm in this finding, and more endpoints only narrow the band where it
 *    happens - nothing here closes it.
 */

/** What the search returns, plus which host answered, for provenance. */
export interface TxSearchResult {
  json: unknown;
  endpoint: string;
  /** True when the primary could not answer and something else did. */
  fellBack: boolean;
}

export class TxSearchError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `tx search ${status}`);
    this.name = 'TxSearchError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Whether another endpoint could plausibly answer better.
 *
 * ONLY FAIL OVER ON SOMETHING ANOTHER HOST MIGHT NOT SAY. A pruned window, a rate
 * limit and a dead node are all properties of the host, so asking a different one is
 * worth a round trip. A 400 or a 404 is a property of the QUERY - a malformed filter,
 * a contract that does not exist - and every endpoint on the chain will answer it
 * identically, so retrying is latency spent to be told the same thing three times.
 *
 * That distinction is the whole reason this is a named function rather than
 * `if (!res.ok)`: failing over on a deterministic refusal would make every genuine
 * "no such contract" three times slower, on a page that renders while it waits.
 */
export function worthAnotherEndpoint(status: number): boolean {
  if (status === 429) return true;
  return status >= 500;
}

/**
 * Chain ids already proved, so the probe is paid once per host per process.
 *
 * A MODULE-SCOPE CACHE IS CORRECT HERE AND WOULD NOT BE FOR DATA. What it holds is a
 * fact about a hostname that does not change while the process lives; a chain does not
 * re-genesis. It is keyed by url, so two deployments pointing at different networks in
 * one process cannot read each other's answer.
 */
const provedChain = new Map<string, boolean>();

/**
 * Does this host actually serve the chain we are reading?
 *
 * THE REASON A FALLBACK NEEDS THIS AND THE PRIMARY DOES NOT. The primary is the
 * operator's own choice and `chainMatch.ts` already surfaces a mismatch on it to the
 * user. A fallback is a hostname compiled in by me, and if one of them ever answers for
 * the wrong chain the failure is silent and ugly: not an error, not an empty chart, but
 * SOMEBODY ELSE'S TRADES rendered as this launch's history, with prices and volumes
 * that look entirely plausible. There is no shape check that catches that, because the
 * data is well formed. Only the chain id does.
 *
 * Unreachable or unparseable answers `false`, so an endpoint that cannot prove itself
 * is simply not used. That is the safe direction: the cost is one fewer fallback.
 */
async function servesOurChain(endpoint: string, timeoutMs = 6_000): Promise<boolean> {
  const cached = provedChain.get(endpoint);
  if (cached !== undefined) return cached;
  /*
   * THROUGH `probeServedChainId`, NOT A SECOND COPY OF THE COMPARISON. The first version
   * of this function read `default_node_info.network` and compared it here, and
   * `app-chain-match.test.ts` failed it: "nothing else compares chain ids for itself".
   * That guard exists because this comparison has been got wrong in this codebase
   * before, and a second implementation means the next correction reaches one of them.
   * Reading the probe's `null` as "did not prove it" is the only logic that belongs here.
   */
  const served = await probeServedChainId(timeoutMs, endpoint);
  const ok = served === NETWORK.chainId;
  provedChain.set(endpoint, ok);
  return ok;
}

/** Test seam: forget what has been proved. */
export function resetProvedChains(): void {
  provedChain.clear();
}

/**
 * Run a transaction search, trying deeper endpoints if the first cannot answer.
 *
 * `path` is everything after the host, so the two callers keep their own query strings
 * and their own `limit`/`order_by` reasoning - both of which are load bearing and
 * documented where they are built. This function owns which host, and nothing else.
 */
export async function txSearch(
  path: string,
  opts: {
    fetchImpl?: typeof fetch;
    endpoints?: string[];
    verify?: (endpoint: string) => Promise<boolean>;
  } = {},
): Promise<TxSearchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const verify = opts.verify ?? servesOurChain;
  const endpoints = opts.endpoints ?? getHistoryEndpoints();
  /*
   * The FIRST refusal is the one reported if nothing answers, not the last. The primary
   * is the operator's configured endpoint, so its words are the ones that describe the
   * deployment: "the window is 16 hours" is actionable, where a fallback's 429 is a
   * fact about a free host the reader never chose.
   */
  let first: TxSearchError | Error | null = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    // Only a fallback has to prove itself; see `servesOurChain`.
    if (i > 0 && !(await verify(endpoint))) continue;
    try {
      const res = await doFetch(`${endpoint}${path}`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new TxSearchError(res.status, body);
        first ??= err;
        if (worthAnotherEndpoint(res.status)) continue;
        throw err;
      }
      return { json: await res.json(), endpoint, fellBack: i > 0 };
    } catch (e) {
      if (e instanceof TxSearchError && !worthAnotherEndpoint(e.status)) throw e;
      first ??= e as Error;
      // A network throw is a property of the host, so the next one is worth asking.
    }
  }
  throw first ?? new TxSearchError(0, '', 'no history endpoint could be reached');
}
