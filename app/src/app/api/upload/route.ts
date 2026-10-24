import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { allowUploadShared, clientKey } from '@/lib/uploadLimit';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, oversizeMessage } from '@/lib/uploadSize';

/**
 * Store a launch logo and hand back a URL the profile can hold.
 *
 * WHY THIS EXISTS. The logo field took a URL and nothing else, so a creator holding a
 * PNG had to go and host it somewhere first, and a launch profile is immutable, so
 * they got one attempt at getting the address right.
 *
 * VERCEL BLOB RATHER THAN IPFS PINNING, and the reason is that it needs nothing from
 * anybody. The previous version read `PINATA_JWT`, which meant a third-party signup
 * before a single creator could upload a file, and until somebody did that the drop
 * zone rendered nothing at all. The store is attached to this project, so
 * `BLOB_READ_WRITE_TOKEN` is injected by the platform and there is no key to obtain,
 * paste, or rotate.
 *
 * The honest trade: a Blob URL is centrally hosted, where an `ipfs://` address is
 * not. For a token's picture that is the right side of the trade, because the picture
 * is not the asset; the denom, the supply and the curve are all on chain and none of
 * them depend on this file resolving. The field still accepts an `ipfs://` address
 * typed by hand for anyone who would rather pin it themselves.
 */

/*
 * THE CAP IS NOT OURS ALONE. Audit F-16: this read 5 MB, and the host refuses a body
 * over 4,500,000 bytes before this function is invoked at all, so between 4.5 and 5 MB
 * the route's own limit was unreachable and its message unsendable. See `uploadSize.ts`
 * for the measurement. The number and the words both come from there now, because they
 * were four hand-written copies of one decision and the page had the stale one.
 */
const MAX_BYTES = MAX_UPLOAD_BYTES;

/*
 * Checked against the sniffed bytes, not the declared type. `Content-Type` on an
 * upload is supplied by the caller, and a file named `a.png` carrying something else
 * is the oldest trick there is. These are the magic numbers for the four formats a
 * token logo is ever actually in.
 */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Uint8Array) => boolean }> = [
  { mime: 'image/png', ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function sniff(bytes: Uint8Array) {
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

/**
 * Whether uploading is available at all.
 *
 * ONE SOURCE OF TRUTH, deliberately. The alternative is a `NEXT_PUBLIC_` flag the
 * operator sets alongside the store, which is two values that can disagree: the flag
 * on and the store missing gives a control that fails when used, and the flag off
 * with a store attached hides a feature that works. The client asks the server, and
 * the server either has the credential or it does not.
 */
export async function GET() {
  return NextResponse.json({ configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN) });
}

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: 'Uploading is not set up on this deployment. Paste a link instead.' },
      { status: 501 },
    );
  }

  /*
   * RATE LIMIT BEFORE ANYTHING ELSE. This endpoint is unauthenticated and writes to
   * paid storage, so without a limit one caller can fill the store and the bill.
   *
   * I DROPPED THIS once already, rewriting the route from IPFS pinning to Blob: the
   * feature kept working, nothing failed, and the protection was simply gone. That
   * is the shape of regression a rewrite produces, and why there is now a test that
   * reads this file for the call.
   */
  if (!(await allowUploadShared(clientKey(req)))) {
    return NextResponse.json(
      { error: 'Too many uploads from here. Wait a few minutes, or paste a link instead.' },
      { status: 429 },
    );
  }

  /*
   * Before the body is parsed. `formData()` reads the whole request into memory, so
   * checking `file.size` afterwards rejects an oversized upload only after paying
   * for it. A declared length over the cap, plus room for the multipart envelope, is
   * refused unread; an undeclared one still meets the `file.size` check below.
   */
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES + 64 * 1024) {
    return NextResponse.json(
      { error: `That image is over the ${MAX_UPLOAD_LABEL} limit.` },
      { status: 413 },
    );
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: 'That upload could not be read.' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });

  // Size first: reading the bytes of something enormous in order to reject it is the
  // expensive order to do this in.
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: oversizeMessage(file.size) }, { status: 413 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    return NextResponse.json({ error: 'That is not a PNG, JPEG, WEBP or GIF.' }, { status: 415 });
  }

  try {
    // A Blob, because `put` does not take a bare Uint8Array. Built from the bytes we
    // sniffed rather than from `file` directly, so what is stored is what was
    // inspected and the declared content type cannot differ from the real one.
    const body = new Blob([bytes as BlobPart], { type: kind.mime });
    const blob = await put(`logos/${crypto.randomUUID()}.${kind.ext}`, body, {
      access: 'public',
      contentType: kind.mime,
      /*
       * The name is a UUID, not the uploader's filename. A caller-supplied path is a
       * path traversal waiting to happen, and two creators uploading `logo.png`
       * should not collide or overwrite each other.
       */
      addRandomSuffix: false,
    });

    /*
     * Rule: a success is not a success until the body has the shape you need. A
     * response carrying no URL would otherwise be written into an immutable profile
     * as the string "undefined".
     */
    if (typeof blob?.url !== 'string' || !blob.url.startsWith('https://')) {
      return NextResponse.json({ error: 'The upload returned no usable address.' }, { status: 502 });
    }
    return NextResponse.json({ uri: blob.url });
  } catch {
    return NextResponse.json({ error: 'That upload did not go through.' }, { status: 502 });
  }
}
