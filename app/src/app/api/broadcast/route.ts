import { NextResponse } from 'next/server';
import { broadcastRawTx, parseSignedTxParts } from '@/lib/txBroadcast';

/**
 * Broadcast a browser-signed transaction.
 *
 * The browser builds and signs the transaction (the key never leaves the wallet) and
 * posts the finished bytes here; this route forwards them to the chain. See
 * `lib/txBroadcast.ts` for why the broadcast cannot run from the browser.
 */
export async function POST(req: Request) {
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
  return NextResponse.json(result);
}
