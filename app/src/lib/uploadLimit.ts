/*
 * A limit on who can spend the operator's pinning quota.
 *
 * /api/upload is public and pins whatever passes its checks to the OPERATOR's
 * Pinata account, so without a limit anyone can script it into a free image host
 * billed to us, hosting whatever they like under our credential.
 *
 * In-memory and per instance, which is a speed bump rather than a wall: a serverless
 * platform runs several instances and recycles them. It stops the casual loop. Put a
 * platform rate limit (Vercel Firewall, or an Upstash-backed limiter) in front of this
 * route before mainnet; docs/AUDIT.md tracks it.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

export function clientKey(req: Request): string {
  // First hop of x-forwarded-for is the client as the platform's proxy saw it.
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Records the attempt and reports whether it is within the limit. */
export function allowUpload(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Bounded memory: drop the oldest keys rather than grow without limit.
  if (hits.size > 10_000) hits.delete(hits.keys().next().value as string);
  return true;
}

/** Test seam: forget every recorded attempt. */
export function resetUploadLimit(): void {
  hits.clear();
}

export const UPLOAD_LIMIT = { windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW };
