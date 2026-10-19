import { getLcdUrl } from './config.ts';
import { describeBroadcastFailure } from './broadcast.ts';

/**
 * Asking the chain what became of a transaction, from the browser.
 *
 * WHY THIS IS ALLOWED TO BE A BROWSER FETCH when `txBroadcast.ts` exists precisely
 * because broadcasting is not. The broadcast is a cross-origin POST with a JSON body,
 * so it triggers a preflight the public LCD does not answer. This is a bare GET with
 * no custom headers, which is a CORS "simple request" and skips the preflight
 * entirely - the same reason every board and balance read in this app already works
 * from the page. So the poll runs where waiting is free and the user can watch it,
 * instead of holding a serverless function open.
 *
 * WHAT THE ENDPOINT ACTUALLY SAYS, measured against the testnet LCD on 19 Oct 2026:
 *
 *     GET /cosmos/tx/v1beta1/txs/AAAA...AAAA
 *     404  {"code":5,"message":"tx not found: AAAA...","details":[]}
 *
 * A TRANSACTION STILL IN THE MEMPOOL AND A TRANSACTION THAT NEVER EXISTED ANSWER
 * IDENTICALLY. There is no field that distinguishes them, so this module cannot and
 * does not try: `pending` means "no answer yet", and running out of patience produces
 * `pending`, never `failed`. The caller holds a hash the node accepted, which is the
 * evidence that the first reading is the right one - but that evidence lives with the
 * caller, not in this response, and inventing a verdict from a 404 would be exactly
 * the kind of confident wrong answer this codebase keeps finding.
 */

export type TxOutcome =
  /** In a block, `code` zero. `height` is the block, read from the chain. */
  | { kind: 'confirmed'; height: number | null }
  /** In a block and refused by it. Settled: nothing about this will change. */
  | { kind: 'failed'; message: string; detail: string }
  /** Not visible yet. Says nothing about whether it ever will be. */
  | { kind: 'pending' };

interface TxResponseShape {
  tx_response?: { code?: number | string; height?: string; raw_log?: string; txhash?: string };
}

/** One read. `pending` covers both "not there yet" and "the node did not answer". */
export async function readTxOutcome(txHash: string): Promise<TxOutcome> {
  let body: TxResponseShape;
  try {
    const res = await fetch(`${getLcdUrl()}/cosmos/tx/v1beta1/txs/${txHash}`, {
      headers: { accept: 'application/json' },
    });
    /*
     * 404 is the expected answer for most of this transaction's life, so it is not
     * logged, not retried differently and not escalated. Any other non-200 is a node
     * having a bad time, which is equally not evidence about the transaction.
     */
    if (!res.ok) return { kind: 'pending' };
    body = (await res.json()) as TxResponseShape;
  } catch {
    return { kind: 'pending' };
  }

  /*
   * A 200 IS NOT AN ANSWER UNTIL THE BODY HAS THE SHAPE. A proxy, a captive portal or
   * a framework fallback can all return 200 with something else entirely, and reading
   * `code` off that yields `undefined`, which would coerce to a confirmation.
   */
  const r = body?.tx_response;
  if (!r || typeof r.txhash !== 'string') return { kind: 'pending' };

  const code = Number(r.code ?? 0);
  if (code !== 0) {
    const raw = r.raw_log ?? '';
    return { kind: 'failed', message: describeBroadcastFailure(raw), detail: raw };
  }
  const height = Number(r.height);
  return { kind: 'confirmed', height: Number.isFinite(height) && height > 0 ? height : null };
}

/**
 * How long the browser keeps asking.
 *
 * Injective produces sub-second blocks, so a transaction the node accepted is
 * normally in one within a second or two and this loop ends on its first or second
 * read. The long tail is the reason for the ceiling: a mempool backlog, a node that
 * has fallen behind, a sequence that landed out of order. Forty seconds is past the
 * point where watching helps, and the dialog then shows the hash and an explorer link
 * rather than a verdict.
 */
const POLL_CEILING_MS = 40_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Polls until the chain answers or the ceiling is reached.
 *
 * `onTick` fires after every read with the seconds elapsed, so a dialog can show a
 * figure it MEASURED rather than animate one. That distinction is the whole reason
 * this returns a loop instead of a promise with a spinner over it: a progress bar
 * driven by a timer tells the user how long they have waited dressed up as how far
 * the work has got, and those are different claims.
 */
export async function pollTxOutcome(
  txHash: string,
  opts: { onTick?: (secondsElapsed: number) => void; signal?: AbortSignal } = {},
): Promise<TxOutcome> {
  const startedAt = Date.now();
  for (;;) {
    if (opts.signal?.aborted) return { kind: 'pending' };
    const outcome = await readTxOutcome(txHash);
    if (outcome.kind !== 'pending') return outcome;
    const elapsed = Date.now() - startedAt;
    opts.onTick?.(Math.floor(elapsed / 1000));
    if (elapsed >= POLL_CEILING_MS) return { kind: 'pending' };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
