/*
 * A limit on who can spend the operator's pinning quota.
 *
 * /api/upload is public and writes whatever passes its checks to the OPERATOR's
 * Vercel Blob store, so without a limit anyone can script it into a free image host
 * billed to us, hosting whatever they like under our credential. (It said "Pinata"
 * until the route moved to Blob; the hazard is the same, the bill is just ours by a
 * different route.)
 *
 * /api/broadcast needs the same treatment for a different reason: it relays a signed
 * transaction, which nobody can forge, but anyone can spam it and spend our function
 * invocations and our IP's standing with the public LCD. It gets a larger budget,
 * because a trader legitimately broadcasts far more often than they upload a logo.
 *
 * `allowUpload` is in-memory and per instance: a speed bump, since a serverless
 * platform runs several instances and recycles them. `allowUploadShared` below is the
 * real limit, shared through Redis, when UPSTASH_REDIS_REST_URL and _TOKEN are set.
 * Production should set them (or put Vercel Firewall rate limiting on the route).
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

/**
 * Per-route budgets.
 *
 * Named buckets rather than one shared number, because the right limit differs by an
 * order of magnitude: uploading a logo is a once-per-launch act, and broadcasting is
 * once per trade. A single budget would either throttle traders or leave the storage
 * endpoint wide open, and the tempting fix, copying the module, is how two limiters
 * drift apart.
 */
export const LIMITS = {
  upload: { windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW },
  broadcast: { windowMs: 60 * 1000, maxPerWindow: 30 },
} as const;

export type LimitBucket = keyof typeof LIMITS;

export function clientKey(req: Request): string {
  // First hop of x-forwarded-for is the client as the platform's proxy saw it.
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Records the attempt and reports whether it is within the limit. */
export function allowUpload(key: string, now = Date.now(), bucket: LimitBucket = 'upload'): boolean {
  const { windowMs, maxPerWindow } = LIMITS[bucket];
  const k = `${bucket}:${key}`;
  const recent = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= maxPerWindow) {
    hits.set(k, recent);
    return false;
  }
  recent.push(now);
  hits.set(k, recent);
  // Bounded memory: drop the oldest keys rather than grow without limit.
  if (hits.size > 10_000) hits.delete(hits.keys().next().value as string);
  return true;
}

/** Test seam: forget every recorded attempt. */
export function resetUploadLimit(): void {
  hits.clear();
}

export const UPLOAD_LIMIT = { windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW };

/*
 * The same limit, shared across every instance, when a Redis is configured.
 *
 * Upstash's REST API, so no client library and no connection to hold open from a
 * serverless function. Server-only variables (no `NEXT_PUBLIC_`), because the token
 * can write to the database. A fixed window: `SET key 0 PX window NX` starts it once,
 * `INCR` counts into it, and the key expires on its own.
 *
 * FAILS TO THE IN-MEMORY LIMIT, not open. If Redis is down or misconfigured the route
 * still limits per instance rather than becoming unlimited, and it never fails closed
 * either: a Redis outage must not take logo uploads down with it.
 */
export async function allowUploadShared(
  key: string,
  opts: {
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
    now?: number;
    bucket?: LimitBucket;
  } = {},
): Promise<boolean> {
  const bucket = opts.bucket ?? 'upload';
  const { windowMs, maxPerWindow } = LIMITS[bucket];
  const url = (opts.url ?? process.env.UPSTASH_REDIS_REST_URL ?? '').trim();
  const token = (opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
  if (!url || !token) return allowUpload(key, opts.now, bucket);
  const redisKey = `injpad:${bucket}:${key}`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', redisKey, '0', 'PX', String(windowMs), 'NX'],
        ['INCR', redisKey],
      ]),
    });
    if (!res.ok) return allowUpload(key, opts.now, bucket);
    const out = (await res.json()) as Array<{ result?: unknown }>;
    const count = Number(out?.[1]?.result);
    if (!Number.isFinite(count)) return allowUpload(key, opts.now, bucket);
    return count <= maxPerWindow;
  } catch {
    return allowUpload(key, opts.now, bucket);
  }
}
