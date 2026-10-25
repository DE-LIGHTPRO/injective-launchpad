import { NextResponse } from 'next/server';

import { allowUploadShared, clientKey } from '@/lib/uploadLimit';
import { fetchLaunchImage } from '@/lib/imageFetch';

/**
 * Re-serve a launch logo from our own origin.
 *
 * Audit F-03. A launch stores an arbitrary `https://` URL and every visitor fetched it
 * directly, so the host a creator chose saw the IP of everyone who looked at their
 * token, and the bytes at that address stayed theirs to change after people had bought.
 * See `lib/imageFetch.ts` for what this fixes outright, what it only mitigates, and the
 * server-side request forgery guards that make fetching a creator-supplied URL safe
 * enough to do at all.
 *
 * A FAILURE IS A 404 WITH NO DETAIL, deliberately. The reason is useful to us and is
 * logged; returned to a caller it is an oracle. "address not permitted" against
 * "upstream answered 500" tells whoever is probing which internal hostnames resolve,
 * which is the reconnaissance half of the attack this route is hardened against. The
 * component that renders these already treats any failure as "no image" and draws its
 * lettered fallback, so there is nothing a message would improve.
 */
export async function GET(req: Request) {
  /*
   * RATE LIMITED ON THE BROADCAST BUDGET. This is the only route here that makes an
   * outbound request to an address someone else chose, so without a limit it is a
   * free bandwidth amplifier and a way to spend our function invocations. The upload
   * budget is far too small: a single board page renders many logos.
   */
  if (!(await allowUploadShared(clientKey(req), { bucket: 'broadcast' }))) {
    return new NextResponse(null, { status: 429 });
  }

  const raw = new URL(req.url).searchParams.get('u');
  if (!raw) return new NextResponse(null, { status: 404 });

  const got = await fetchLaunchImage(raw);
  if (!got.ok) {
    console.error('[img] refused:', got.reason, '|', raw.slice(0, 120));
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(got.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      /*
       * The SNIFFED type, never the upstream's. `nosniff` on top of it, so a browser
       * cannot decide for itself that these bytes are something more interesting.
       */
      'content-type': got.kind.mime,
      'x-content-type-options': 'nosniff',
      /*
       * A LONG CACHE IS THE HALF THAT MITIGATES THE SWAP. A logo is immutable in
       * practice and the profile pointing at it is immutable on chain, so the only
       * thing a short cache buys is faster propagation of a change the creator should
       * not be making. A day at the edge, `immutable` so a browser does not
       * revalidate, and `stale-while-revalidate` so a slow or dead upstream serves the
       * last good bytes rather than a gap.
       *
       * It does not FREEZE the image, and nothing here does. Only copying the bytes at
       * launch time would, and that cannot help a launch that already exists.
       */
      'cache-control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, immutable',
      /*
       * A creator-supplied image is not a document and must never be treated as one if
       * it is opened directly: `attachment` means a browser downloads rather than
       * renders, which closes the last path by which a crafted file served from this
       * origin could act like a page.
       */
      'content-disposition': 'inline',
    },
  });
}

/** One outbound fetch with a six second ceiling; this is headroom, not a budget. */
export const maxDuration = 15;
