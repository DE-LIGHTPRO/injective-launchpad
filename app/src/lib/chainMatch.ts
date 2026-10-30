import { NETWORK, getLcdUrl, isEvm } from './config.ts';

/**
 * Does the endpoint this app reads from serve the chain this app signs for?
 *
 * THE DEFECT THIS EXISTS FOR. Two variables choose two halves of one decision and
 * nothing compared them. `NEXT_PUBLIC_NETWORK` picks `NETWORK.chainId`, which is what
 * the wallet is asked to enable and what every signature commits to; it also picks the
 * denom creation fee, the explorer, and the default endpoint. `NEXT_PUBLIC_LCD_URL`
 * overrides the endpoint on its own, and that endpoint serves the board, every balance,
 * the account number and sequence a transaction is signed against, and the broadcast.
 * Set one and not the other and both halves are individually correct.
 *
 * `scripts/payout-keeper.mjs` already asks this question, for exactly this reason and in
 * these words. The app did not, which is a guard scoped to one branch of a defect that
 * has two: the runbook sets both variables for the keeper AND for the deployed app, as
 * separate steps, and the app is the half a person looks at.
 *
 * WHAT A MISMATCH LOOKS LIKE WITHOUT THIS. Nothing errors where the error is. The board
 * fills with the other chain's launches and reads as the market. Cost estimates use the
 * other chain's denom fee, which differ by 10x between these two chains. The failure
 * surfaces only at broadcast, after the user has signed, as a refusal that names a chain
 * id and nothing else. A mainnet visitor would be looking at testnet prices.
 *
 * WHY IT ASKS INSTEAD OF INFERRING. The endpoint is the only thing that can tell a
 * mainnet LCD from a testnet one. Reading `NEXT_PUBLIC_NETWORK` to decide what the
 * endpoint is would be deriving the answer from one of the two values being checked.
 */

export type ChainMatch =
  | { verdict: 'match'; served: string }
  | { verdict: 'mismatch'; served: string; expected: string }
  | { verdict: 'unknown' };

/**
 * The comparison, with no network in it.
 *
 * `null` is NO OPINION, never a mismatch. An endpoint that did not answer is already
 * reported by the read that failed, with better words, and treating silence as a
 * mismatch would put a configuration banner on the screen for a dropped connection.
 * That is the same distinction `getStatus` draws between untested and offline.
 */
export function assessChainMatch(served: string | null | undefined): ChainMatch {
  const id = served?.trim();
  if (!id) return { verdict: 'unknown' };
  if (id === NETWORK.chainId) return { verdict: 'match', served: id };
  return { verdict: 'mismatch', served: id, expected: NETWORK.chainId };
}

/**
 * Ask an endpoint which chain it is. One request, no retry.
 *
 * Every failure path returns null rather than throwing, because this runs on page load
 * beside the reads that matter and must never be the reason a page does not render.
 *
 * `endpoint` DEFAULTS TO THE CONFIGURED ONE AND EXISTS FOR THE HISTORY FALLBACKS.
 * `txSearch` has to know whether a fallback host serves this chain before it trusts a
 * single number from it, and the first version of that file asked the question itself -
 * a second place comparing chain ids, which `app-chain-match.test.ts` refused, and was
 * right to: this comparison has been got wrong here before, and two copies means the
 * next fix lands on one of them. The parameter is the whole change.
 */
export async function probeServedChainId(
  timeoutMs = 8_000,
  endpoint: string = getLcdUrl(),
): Promise<string | null> {
  /*
   * THE PROBE HAS TO SPEAK THE BACKEND'S OWN PROTOCOL, and it did not.
   *
   * This banner exists to say when the endpoint being read is not the chain being
   * signed for. On the EVM backend it asked a JSON-RPC host for a Cosmos route,
   * `/cosmos/base/tendermint/v1beta1/node_info`, which fails - so the probe returned
   * null, the verdict was `unknown`, and the banner rendered nothing. The one guard
   * built for this class of defect was blind on the backend where the defect was live:
   * `evmClient` was reading the hardcoded default instead of the configured endpoint,
   * and nothing said a word.
   *
   * In a browser it was worse than silent - it was a CORS failure logged on every page
   * load, which is how it was found.
   */
  if (isEvm()) return probeEvmChainId(endpoint, timeoutMs);

  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/cosmos/base/tendermint/v1beta1/node_info`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    /*
     * A 200 is not an answer: this origin also serves the app, so a misrouted request
     * can land on an HTML page with a 200 and `json()` would throw rather than return a
     * chain id. Shape is checked, not status.
     */
    const body: unknown = await res.json();
    const network = (body as { default_node_info?: { network?: unknown } })?.default_node_info
      ?.network;
    return typeof network === 'string' && network.trim() ? network.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The EVM half of the probe: `eth_chainId`, as a decimal string.
 *
 * Decimal because that is what `NETWORK.chainId` holds for this backend ("1776") and
 * what `assessChainMatch` compares against. Returning the hex would make every
 * comparison a mismatch, which is the same defect one step along - a guard that cries
 * wolf is uninstalled as fast as one that says nothing.
 *
 * Shape checked, not status: a 200 from something that is not a JSON-RPC node must not
 * become a chain id.
 */
async function probeEvmChainId(endpoint: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(endpoint.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
    return BigInt(body.result).toString();
  } catch {
    return null;
  }
}
