import { getLcdUrl } from './config.ts';
import { describeBroadcastFailure, GENERIC_CHAIN_REFUSAL } from './broadcast.ts';
import type { SignedTxParts } from './txBroadcast.ts';

/**
 * Running the transaction against the chain BEFORE the wallet prompt.
 *
 * WHY THIS EXISTS, AND IT IS NOT PRIMARILY ABOUT GAS. `broadcast.ts` claimed in its own
 * docblock that "`simulateLaunch` exists so that failure happens before a wallet
 * prompt", and no such function had ever been written. That sentence was the fourth and
 * last bullet of the argument for shipping an unexercised transaction builder - the one
 * covering the residual risk the other three bullets do not - so the only part of that
 * argument resting on code rather than on reasoning was resting on nothing. Audit F-09.
 *
 * What a simulation buys is the difference between a user approving a doomed prompt and
 * never seeing it. The audit's own F-05 finding is two create transactions in testnet
 * blocks eight seconds apart, the second of which could only ever fail, and what the
 * creator got for the gas was an error. A simulation runs the real messages against real
 * current state and the contract's own refusals come back in the contract's own words.
 *
 * SERVER-SIDE FOR THE SAME REASON THE BROADCAST IS. A simulate is a POST with a JSON
 * body, so from a browser it is cross-origin and triggers a preflight the public LCD
 * does not answer: the request is blocked before it is sent and nothing on the page can
 * catch it. Written in the browser this would have failed silently and every simulation
 * would have come back "unavailable", which fails open - so it would have looked exactly
 * like it was working. See `txBroadcast.ts`, where this cost a launch.
 *
 * NOTHING IS SIGNED TO SIMULATE ONE. The bytes carry a zero signature, because a node
 * does not verify the signature when simulating. That is the whole point: no prompt.
 *
 * NOT THROUGH `TxRestApi.simulate`, AND THAT WAS THE FIRST IMPLEMENTATION. The SDK
 * surfaces only the HTTP status text, so every refusal arrived as the string
 * "Internal Server Error" - measured against testnet, where the node's own body read
 * `account sequence mismatch, expected 32728946, got 32727074`. A status line is never
 * specific, so `specificReasonFor` would have returned null for every refusal there is,
 * every simulation would have fallen open to `unavailable`, and the whole path would
 * have been INERT: wired, correctly ordered, passing its tests, and refusing nothing.
 * The node's JSON body is the only place the reason exists, so this reads it directly.
 */

/**
 * Three outcomes, and the third is the one that keeps this honest.
 *
 * A simulation that could not be performed is not a simulation that passed, and it is
 * not one that failed either. Collapsing `unavailable` into either direction is the
 * defect: read as a pass it claims a check nobody ran, and read as a failure it turns
 * someone else's outage into a refusal of the user's trade.
 */
export type SimulateResult =
  /** The node ran it. `gasUsed` is measured, not estimated. */
  | { ok: true; gasUsed: number }
  /** The chain refused it, in words we can specifically explain. */
  | { ok: false; refused: string; detail?: string }
  /** We could not ask, or could not understand the answer. No verdict. */
  | { ok: false; unavailable: string };

/** Long enough for a slow node, short enough that nothing waits on it. */
const SIMULATE_TIMEOUT_MS = 8_000;

const fromB64 = (s: string): Buffer => Buffer.from(s, 'base64');

/**
 * `TxRaw`, encoded by hand.
 *
 * Three length-delimited protobuf fields and nothing else:
 *
 *     message TxRaw { bytes body_bytes = 1; bytes auth_info_bytes = 2;
 *                     repeated bytes signatures = 3; }
 *
 * Hand-encoded because the SDK does not export a `TxRaw` encoder on the object
 * `createTransaction` returns, and the alternative was reaching into a transitive
 * dependency's proto namespace for one. Three tags, three lengths: a wire format small
 * enough to read in full is safer here than a path through a package nobody pinned.
 *
 * The tag byte is `(field << 3) | 2`, where 2 is the length-delimited wire type: 0x0A,
 * 0x12, 0x1A. Verified end to end against a live node, which answered
 * `gas_info.gas_used: 120551` for a bank send - a malformed encoding would have been
 * refused as undecodable instead.
 */
function encodeTxRaw(bodyBytes: Buffer, authInfoBytes: Buffer, signatures: Buffer[]): Buffer {
  const varint = (n: number): Buffer => {
    const out: number[] = [];
    while (n > 127) {
      out.push((n & 127) | 128);
      n >>>= 7;
    }
    out.push(n);
    return Buffer.from(out);
  };
  const field = (num: number, buf: Buffer) =>
    Buffer.concat([Buffer.from([(num << 3) | 2]), varint(buf.length), buf]);
  return Buffer.concat([
    field(1, bodyBytes),
    field(2, authInfoBytes),
    ...signatures.map((s) => field(3, s)),
  ]);
}

/**
 * Whether a failure is one we can name.
 *
 * WE ONLY PRE-EMPT A FAILURE WE CAN EXPLAIN, which is the rule that makes blocking the
 * user safe. `describeBroadcastFailure` recognises the curve's own refusals - slippage,
 * the wallet cap, trading not open, a taken ticker, a stale sequence - and falls back to
 * a generic sentence for everything else. A generic sentence is not a diagnosis, so a
 * simulation that fails for a reason we cannot state is treated as no verdict at all and
 * the user goes to their wallet exactly as they did before this file existed.
 *
 * The cost of that choice is the status quo: the chain refuses it and the user is out
 * the fee. The cost of the other choice is refusing a legitimate trade because our own
 * plumbing answered oddly, which is the failure this product cannot afford.
 */
function specificReasonFor(raw: string): string | null {
  const described = describeBroadcastFailure(raw);
  return described === GENERIC_CHAIN_REFUSAL ? null : described;
}

/**
 * `fetchImpl` and `lcdUrl` are a test seam, the same one `allowUploadShared` carries.
 *
 * They exist because the defect that mattered here was INVISIBLE WITHOUT ONE. The first
 * version read `gasInfo.gasUsed` from the response - the SDK's camelCase view - where
 * the node's own JSON says `gas_info.gas_used`. Every simulation would have measured
 * `undefined`, fallen back, and failed open: silent, and in the direction that looks
 * exactly like it is working. No source read would catch that and no test could reach
 * it, so the shapes this parses are now pinned against bodies measured off a real node.
 */
export async function simulateRawTx(
  parts: SignedTxParts,
  opts: { fetchImpl?: typeof fetch; lcdUrl?: string } = {},
): Promise<SimulateResult> {
  let txBytes: string;
  try {
    txBytes = encodeTxRaw(
      fromB64(parts.bodyBytes),
      fromB64(parts.authInfoBytes),
      parts.signatures.map(fromB64),
    ).toString('base64');
  } catch (e) {
    return { ok: false, unavailable: `the transaction could not be encoded: ${(e as Error).message}` };
  }

  let status: number;
  let body: Record<string, unknown> | null;
  try {
    const resp = await (opts.fetchImpl ?? fetch)(
      `${(opts.lcdUrl ?? getLcdUrl()).replace(/\/$/, '')}/cosmos/tx/v1beta1/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx_bytes: txBytes }),
      signal: AbortSignal.timeout(SIMULATE_TIMEOUT_MS),
    },
    );
    status = resp.status;
    body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  } catch (e) {
    console.error('[simulate] could not reach the node:', (e as Error)?.message);
    return { ok: false, unavailable: (e as Error)?.message || 'the node could not be reached' };
  }

  if (status !== 200) {
    /*
     * The node's own words live in `message`, and this is the only place they exist: the
     * status is 500 for a contract refusal and for a dead node alike, so the status
     * cannot classify this and the body is not optional.
     */
    const raw = typeof body?.message === 'string' ? body.message : '';
    const reason = specificReasonFor(raw);
    if (reason) {
      console.error('[simulate] chain refused:', raw);
      return { ok: false, refused: reason, detail: raw };
    }
    console.error('[simulate] unexplained failure, status', status, '|', raw.slice(0, 300));
    return { ok: false, unavailable: raw || `the node answered ${status}` };
  }

  /*
   * RULE: A 200 IS NOT A RESULT UNTIL ITS SHAPE IS CHECKED. A 200 carrying no
   * `gas_used` read as a successful simulation of zero gas, and zero would then be
   * multiplied to zero and sent as the limit - a transaction guaranteed to run out of
   * gas, produced by the very check meant to prevent it.
   *
   * SNAKE_CASE, because this is the node's own JSON and not the SDK's view of it. The
   * first version read `gasInfo.gasUsed`, which is what the SDK would have returned and
   * is `undefined` here: every simulation would have measured nothing and fallen back,
   * silently, in the direction that looks like it is working.
   */
  const gasInfo = body?.gas_info as { gas_used?: unknown } | undefined;
  const gasUsed = Number(gasInfo?.gas_used);
  if (!Number.isFinite(gasUsed) || gasUsed <= 0) {
    console.error('[simulate] no usable gas_used:', JSON.stringify(body)?.slice(0, 300));
    return { ok: false, unavailable: 'the simulation returned no gas measurement' };
  }
  return { ok: true, gasUsed };
}
