import { NextResponse } from 'next/server';
import { allowUploadShared, clientKey } from '@/lib/uploadLimit';
import { parseSignedTxParts } from '@/lib/txBroadcast';
import { simulateRawTx } from '@/lib/txSimulate';

/**
 * Run a transaction against the chain without signing or sending it.
 *
 * The browser builds the transaction, attaches a zero signature and posts the bytes
 * here; this route asks the node what would happen. See `lib/txSimulate.ts` for why the
 * simulation cannot run from the browser, which is the same reason the broadcast cannot.
 *
 * ALWAYS 200. The three outcomes - measured, refused, could not ask - are all legitimate
 * answers to "what would happen", and only the body distinguishes them. A 502 for an
 * unreachable node would put the caller's `catch` in charge of a decision that needs the
 * distinction, and a caller that cannot tell "refused" from "not asked" is the defect
 * this whole path exists to avoid.
 */
export async function POST(req: Request) {
  /*
   * On the `broadcast` budget, not the upload one. A simulation runs before every trade,
   * so it is at least as frequent as a broadcast and nothing like a logo upload. It
   * spends our function invocations and our IP's standing with the public LCD, which is
   * the same exposure the broadcast route is limited for.
   */
  if (!(await allowUploadShared(clientKey(req), { bucket: 'broadcast' }))) {
    return NextResponse.json(
      { unavailable: 'Too many requests from here. Wait a moment and try again.' },
      { status: 429 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ unavailable: 'The request body was not valid JSON.' }, { status: 400 });
  }

  /*
   * The same validator the broadcast route uses, because the bytes are the same shape:
   * a signature array of the right length, holding zeros rather than a signature. A
   * second parser here would be a second thing to keep in step.
   */
  const parts = parseSignedTxParts(parsed);
  if (!parts) {
    return NextResponse.json({ unavailable: 'The transaction was incomplete.' }, { status: 400 });
  }

  return NextResponse.json(await simulateRawTx(parts));
}

/**
 * Shorter than the broadcast route's, because nothing is waited for here.
 *
 * A simulate is one request to the node with no inclusion poll behind it. This is
 * headroom for a slow LCD, not a budget anything plans to spend, and it is declared
 * rather than inherited for the reason recorded on the broadcast route: a function with
 * no `maxDuration` takes the platform default, and nobody had compared that against what
 * the SDK underneath was willing to block for.
 */
export const maxDuration = 15;
