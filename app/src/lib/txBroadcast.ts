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

export type BroadcastResult = { txHash: string } | { error: string; detail?: string };

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
  try {
    const api = new TxRestApi(getLcdUrl());
    // Same shape the browser passed `createTransaction`'s `txRaw` directly; rebuilt here
    // from the bytes the browser sent.
    const result = await api.broadcast(txRaw as never);
    /*
     * A 200 from the node is not a landed transaction: `broadcast` carries the chain's
     * own `code`, and anything but zero is a refusal that arrived with a success status.
     */
    if (result.code !== 0) {
      // Logged server-side so the raw node reason is visible in the dev/server logs
      // while the user only ever sees the translated sentence. Temporary aid while the
      // signing path is being brought up against a live chain.
      console.error('[broadcast] chain rejected tx, code', result.code, '| rawLog:', result.rawLog);
      return { error: describeBroadcastFailure(result.rawLog ?? ''), detail: result.rawLog };
    }
    return { txHash: result.txHash };
  } catch (e) {
    console.error('[broadcast] threw before/while sending:', (e as Error)?.stack ?? e);
    return {
      error: describeBroadcastFailure((e as Error).message ?? ''),
      detail: (e as Error).message,
    };
  }
}
