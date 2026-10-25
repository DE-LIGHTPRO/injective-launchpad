/**
 * What kind of image a byte string actually is.
 *
 * SNIFFED, NEVER DECLARED, and the reason is older than this project: a `Content-Type`
 * header is supplied by whoever sent the bytes, and a file named `a.png` carrying
 * something else is the oldest trick there is. The upload route has said so since it
 * was written; this module exists because a SECOND caller now needs the same answer and
 * the alternative was a second copy of the table.
 *
 * `/api/img` is that caller, and for it the stakes are different from an upload's. It
 * re-serves bytes fetched from an address a launch creator chose, from our own origin -
 * so what this function returns becomes the `Content-Type` WE assert about somebody
 * else's bytes. Getting that wrong means serving `text/html` from our domain on a
 * creator's behalf, which is a stored cross-site scripting hole with extra steps. The
 * only safe answer is a type derived from the bytes, and nothing served at all when
 * none of these match.
 */
export interface ImageKind {
  mime: string;
  ext: string;
}

const SIGNATURES: Array<ImageKind & { test: (b: Uint8Array) => boolean }> = [
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

/** The four formats a token logo is ever actually in, or null. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const hit = SIGNATURES.find((s) => s.test(bytes));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

/** Every type this product will serve or store. Nothing else is an image here. */
export const IMAGE_MIMES: readonly string[] = SIGNATURES.map((s) => s.mime);
