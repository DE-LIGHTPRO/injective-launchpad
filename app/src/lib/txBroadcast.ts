import { TxRestApi } from '@injectivelabs/sdk-ts';
import { getLcdUrl } from './config.ts';
import { describeBroadcastFailure } from './broadcast.ts';

/**
 * Broadcasting a browser-signed transaction from the server.
 *
 * WHY THIS EXISTS. The wallet signs in the browser and the key never leaves it, but the
 * broadcast itself cannot run there. A browser POST to the LCD is cross-origin with a
 * JSON body, so it triggers a CORS preflight (`OPTIONS`) that the public LCD does not
 * answer, and the request is blocked before it is sent, with no error the page can show.
 * The app's GET reads are "simple" requests that skip the preflight, so the board and
 * balances load and everything looks fine until the first broadcast, which "does
 * nothing" after signing. Observed creating a launch on testnet: the wallet signed, then
 * silence.
 *
 * Forwarding the already-signed bytes through our own origin removes the cross-origin
 * call, and the inclusion poll runs here where it is reliable and not subject to a
 * browser's preflight. Nothing secret passes through: the transaction is already signed,
 * and the signature authorises only this exact transaction.
 */
export interface SignedTxParts {
  /** base64 of the proto `TxBody` bytes. */
  bodyBytes: string;
  /** base64 of the proto `AuthInfo` bytes. */
  authInfoBytes: string;
  /** base64 signatures, one per signer (here always one). */
  signatures: string[];
}

/**
 * What came back, and crucially WHETHER THE CHAIN HAS ANSWERED YET.
 *
 * `settled` is the whole point of this type. A transaction has three fates, not two:
 * it landed, it was refused, or nobody knows yet - and the third is the common one,
 * because this route gives up waiting long before the chain does (see
 * `INCLUSION_WAIT_MS`). Collapsing the third into a refusal is how the old shape lied.
 */
export type BroadcastResult =
  | { txHash: string; height: number | null; settled: true }
  /** Broadcast accepted, inclusion not observed before we stopped waiting. */
  | { txHash: string; height: null; settled: false }
  | { error: string; detail?: string; settled: boolean };

/**
 * How long this route waits for the transaction to appear in a block.
 *
 * NOT THE SDK'S DEFAULT, WHICH IS 42 SECONDS, and that default is what made this
 * route unsafe. `DEFAULT_BLOCK_TIMEOUT_HEIGHT` (60) times
 * `DEFAULT_BLOCK_TIME_IN_SECONDS` (0.7) is 42,000ms of blocking inside a serverless
 * function that has no `maxDuration` and therefore takes the platform default. The
 * platform kills the function first, the browser gets a dead socket, and
 * `broadcast.ts` reports "The transaction was signed but could not be sent... nothing
 * was created." Every clause of that is false for a transaction already in the
 * mempool: it was sent, and it probably created exactly what it was meant to.
 *
 * So the wait is short and bounded, and running out is reported as `settled: false`
 * with the hash, never as a failure. The browser polls on from there, where waiting
 * costs nothing and the user can watch it. Injective blocks are sub-second, so six
 * seconds is roughly ten blocks: a transaction that has not appeared by then is not
 * going to appear by second seven either, and the honest thing is to hand the caller
 * the hash rather than keep a function warm.
 */
const INCLUSION_WAIT_MS = 6_000;

/**
 * Validate the posted body into signed parts, or null if it is not a complete signed
 * transaction. Kept here, not in the route, so it can be tested without the `@/` path
 * alias the route uses (the test runner does not resolve that alias).
 */
export function parseSignedTxParts(input: unknown): SignedTxParts | null {
  const p = input as { bodyBytes?: unknown; authInfoBytes?: unknown; signatures?: unknown };
  if (
    typeof p?.bodyBytes !== 'string' ||
    typeof p?.authInfoBytes !== 'string' ||
    !Array.isArray(p?.signatures) ||
    p.signatures.length === 0 ||
    !p.signatures.every((s) => typeof s === 'string')
  ) {
    return null;
  }
  return { bodyBytes: p.bodyBytes, authInfoBytes: p.authInfoBytes, signatures: p.signatures as string[] };
}

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export async function broadcastRawTx(parts: SignedTxParts): Promise<BroadcastResult> {
  const txRaw = {
    bodyBytes: fromB64(parts.bodyBytes),
    authInfoBytes: fromB64(parts.authInfoBytes),
    signatures: parts.signatures.map(fromB64),
  };
  /*
   * The hash the NODE gave back, captured the moment the broadcast is accepted and
   * before the inclusion wait starts.
   *
   * This is what separates "we do not know yet" from "it never left": holding a hash
   * means the node took the transaction into its mempool, so the bytes are valid, the
   * signature verified and the fee was payable. Whatever goes wrong after that is a
   * question about a transaction that exists.
   */
  let acceptedHash: string | null = null;
  try {
    const api = new TxRestApi(getLcdUrl());
    // Same shape the browser passed `createTransaction`'s `txRaw` directly; rebuilt here
    // from the bytes the browser sent.
    const result = await api.broadcast(txRaw as never, {
      timeout: INCLUSION_WAIT_MS,
      onBroadcast: (hash: string) => {
        acceptedHash = hash;
      },
    } as never);
    /*
     * A 200 from the node is not a landed transaction: `broadcast` carries the chain's
     * own `code`, and anything but zero is a refusal that arrived with a success status.
     */
    if (result.code !== 0) {
      // Logged server-side so the raw node reason is visible in the dev/server logs
      // while the user only ever sees the translated sentence. Temporary aid while the
      // signing path is being brought up against a live chain.
      console.error('[broadcast] chain rejected tx, code', result.code, '| rawLog:', result.rawLog);
      return { error: describeBroadcastFailure(result.rawLog ?? ''), detail: result.rawLog, settled: true };
    }
    const height = Number(result.height);
    return { txHash: result.txHash, height: Number.isFinite(height) && height > 0 ? height : null, settled: true };
  } catch (e) {
    /*
     * A REFUSAL AND A TIMEOUT ARRIVE AS THE SAME `catch`, and telling them apart is
     * the reason this function was changed at all.
     *
     * The SDK throws `TransactionException` with a `contextCode` when the chain
     * refused the transaction - at CheckTx, or in the block, since its `fetchTx`
     * throws on a non-zero code too. It throws a plain request exception when the
     * inclusion poll simply ran out. Those are opposite facts and both used to come
     * back as "The chain refused the transaction."
     *
     * The test is the hash, not the message. Matching on the SDK's timeout wording
     * would bind us to a string in a dependency; a hash means the node accepted the
     * bytes, and a thrown error with no chain code against an accepted transaction
     * means nothing was decided. That reasoning survives the SDK rewording itself.
     */
    const code = (e as { contextCode?: unknown }).contextCode;
    const refusedOnChain = typeof code === 'number' || typeof code === 'string';
    if (acceptedHash && !refusedOnChain) {
      console.error('[broadcast] accepted but inclusion not observed:', acceptedHash, (e as Error)?.message);
      return { txHash: acceptedHash, height: null, settled: false };
    }
    console.error('[broadcast] threw before/while sending:', (e as Error)?.stack ?? e);
    return {
      error: describeBroadcastFailure((e as Error).message ?? ''),
      detail: (e as Error).message,
      settled: refusedOnChain,
    };
  }
}
