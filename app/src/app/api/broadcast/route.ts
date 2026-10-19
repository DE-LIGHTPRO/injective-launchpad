import { NextResponse } from 'next/server';
import { allowUploadShared, clientKey } from '@/lib/uploadLimit';
import { broadcastRawTx, parseSignedTxParts } from '@/lib/txBroadcast';

/**
 * Broadcast a browser-signed transaction.
 *
 * The browser builds and signs the transaction (the key never leaves the wallet) and
 * posts the finished bytes here; this route forwards them to the chain. See
 * `lib/txBroadcast.ts` for why the broadcast cannot run from the browser.
 */
export async function POST(req: Request) {
  /*
   * RATE LIMITED, on the `broadcast` budget rather than the upload one.
   *
   * Nobody can forge a signature, so this route cannot be used to send someone
   * else's transaction. What it CAN be used for is spending our function invocations
   * and our IP's standing with the public LCD, which would take the app down for
   * everyone without ever producing an invalid transaction.
   *
   * The budget is far larger than the upload one because a trader legitimately
   * broadcasts many times in a session and uploads a logo once per launch. One
   * shared number would either throttle traders or leave storage wide open.
   */
  if (!(await allowUploadShared(clientKey(req), { bucket: 'broadcast' }))) {
    return NextResponse.json(
      { error: 'Too many broadcasts from here. Wait a moment and try again.' },
      { status: 429 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: 'The request body was not valid JSON.' }, { status: 400 });
  }

  const parts = parseSignedTxParts(parsed);
  if (!parts) {
    return NextResponse.json({ error: 'The signed transaction was incomplete.' }, { status: 400 });
  }

  const result = await broadcastRawTx(parts);
  // 502: the signing succeeded in the browser, so a failure here is the node refusing or
  // unreachable, not the caller's fault.
  if ('error' in result) {
    return NextResponse.json(result, { status: 502 });
  }
  /*
   * A 200 FOR AN UNSETTLED RESULT TOO, and deliberately.
   *
   * `settled: false` means the node accepted the transaction and it had not appeared
   * in a block by the time this route stopped waiting. That is a successful broadcast
   * with an open question attached, not an error: the browser carries on polling for
   * it by hash. A 502 here would have the status assert a failure the body is careful
   * not to assert, which is how a caller ends up trusting the status over the body.
   */
  return NextResponse.json(result);
}

/**
 * Longer than the platform default, and still far longer than the route can take.
 *
 * `broadcastRawTx` stops waiting at six seconds, so this is headroom for a slow LCD
 * rather than a budget anything plans to spend. It is declared because the route
 * previously inherited whatever the platform gave it while the SDK underneath was
 * willing to block for 42 seconds, and nobody had compared the two numbers. The
 * shorter wait is the actual fix; this is the guard rail behind it.
 */
export const maxDuration = 30;
