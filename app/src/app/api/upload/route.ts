import { NextResponse } from 'next/server';

/**
 * Pin a launch logo to IPFS.
 *
 * WHY A SERVER ROUTE. The logo field took a URL and nothing else, so a creator with a
 * PNG on their machine had to go and host it somewhere first. The profile is immutable,
 * so they get one attempt at it. nearly.trade takes the file: "Drop an image here, or
 * pick one."
 *
 * Pinning needs a credential, and a credential cannot live in the browser:
 * `NEXT_PUBLIC_*` is inlined into the bundle at build time, so it would be published
 * and could not be rotated without a rebuild. Hence a route, and hence `PINATA_JWT`
 * with no `NEXT_PUBLIC_` prefix, which is what keeps Next from inlining it.
 *
 * WHEN NO KEY IS SET the route says so plainly and the UI drops the control entirely
 * rather than showing a dead one. A greyed-out Upload button implies a version of this
 * product where it works, and the URL field on its own is a complete, honest answer.
 */

const MAX_BYTES = 5 * 1024 * 1024;

/*
 * Checked against the sniffed bytes, not the declared type. `Content-Type` on an upload
 * is supplied by the caller and a file named `a.png` carrying something else is the
 * oldest trick there is. These are the magic numbers for the four formats a token logo
 * is ever actually in.
 */
const SIGNATURES: Array<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mime: 'image/webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function sniff(bytes: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(bytes))?.mime ?? null;
}

/**
 * Whether uploading is available at all.
 *
 * ONE SOURCE OF TRUTH, deliberately. The alternative is a `NEXT_PUBLIC_` flag the
 * operator sets alongside the key, which is two values that can disagree: the flag on
 * and the key missing gives a control that fails when used, and the flag off with a key
 * present hides a feature that works. The client asks the server, and the server knows
 * because it either has the credential or it does not.
 */
export async function GET() {
  return NextResponse.json({ configured: Boolean(process.env.PINATA_JWT?.trim()) });
}

export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) {
    return NextResponse.json(
      { error: 'Uploading is not set up on this deployment. Paste a link instead.' },
      { status: 501 },
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

  // Size first: reading the bytes of something enormous to then reject it is the
  // expensive order to do this in.
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.` },
      { status: 413 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (!mime) {
    return NextResponse.json(
      { error: 'That is not a PNG, JPEG, WEBP or GIF.' },
      { status: 415 },
    );
  }

  const out = new FormData();
  out.append('file', new Blob([bytes as BlobPart], { type: mime }), file.name || 'logo');

  let res: Response;
  try {
    res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: out,
    });
  } catch {
    return NextResponse.json({ error: 'The pinning service could not be reached.' }, { status: 502 });
  }

  /*
   * A 200 is not a success: check the body's shape. A pinning service answering with
   * an error page, or with JSON that carries no hash, would otherwise be turned into
   * `ipfs://undefined` and written into an immutable token profile.
   */
  if (!res.ok) {
    return NextResponse.json(
      { error: res.status === 401 ? 'The pinning credential was rejected.' : 'The pin failed.' },
      { status: 502 },
    );
  }
  const body = (await res.json().catch(() => null)) as { IpfsHash?: unknown } | null;
  const cid = typeof body?.IpfsHash === 'string' ? body.IpfsHash.trim() : '';
  if (!/^[A-Za-z0-9]{46,}$/.test(cid)) {
    return NextResponse.json({ error: 'The pin returned no usable address.' }, { status: 502 });
  }

  return NextResponse.json({ uri: `ipfs://${cid}` });
}
