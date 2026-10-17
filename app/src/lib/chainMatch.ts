import { NETWORK, getLcdUrl } from './config.ts';

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
 * Ask the configured endpoint which chain it is. One request, no retry.
 *
 * Every failure path returns null rather than throwing, because this runs on page load
 * beside the reads that matter and must never be the reason a page does not render.
 */
export async function probeServedChainId(timeoutMs = 8_000): Promise<string | null> {
  try {
    const res = await fetch(`${getLcdUrl()}/cosmos/base/tendermint/v1beta1/node_info`, {
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
