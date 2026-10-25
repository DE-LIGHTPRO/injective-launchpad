import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { safeExternalUrl } from './tokenProfile.ts';
import { sniffImage, type ImageKind } from './imageSniff.ts';

/**
 * Fetch a launch logo from the address its creator chose, safely, on the server.
 *
 * WHY A PROXY AT ALL. Audit F-03. A launch profile stores an arbitrary `https://` URL
 * and every visitor's browser fetched it directly, which hands the creator two things
 * they should not have. The host they picked sees the IP of everybody who so much as
 * looks at their token - `referrerPolicy="no-referrer"` denies it the referring URL but
 * not the address - and the bytes at that URL are theirs to change after people have
 * bought, so a clean logo at launch can become anything later. The profile is immutable
 * on chain; the picture it points at never was.
 *
 * Proxying fixes the first completely: the creator's host sees this server and no
 * reader. It MITIGATES the second rather than curing it - a cached response means a
 * swap does not propagate until the cache expires, which is not the same as freezing
 * the image. Curing it means copying the bytes at launch time, and that can only ever
 * help launches made afterwards. This helps every launch that already exists, which is
 * why it is the half worth doing first, and the limit is stated rather than glossed.
 *
 * WHAT THIS INTRODUCES, AND IT IS THE REASON THIS FILE IS MOSTLY REFUSALS. A URL
 * fetcher driven by untrusted input is a server-side request forgery primitive: it will
 * fetch, from inside our own network, whatever a launch creator writes on chain. On a
 * serverless platform the interesting targets are the loopback interface and the cloud
 * metadata address, and a plain `fetch` would reach both. Every guard below exists
 * against that, and the order matters: the address is checked BEFORE the request, and
 * redirects are refused rather than followed, because a redirect is a second address
 * that was never checked.
 */

/** Enough for any sane logo, small enough that a hostile URL cannot cost much. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6_000;

export type ImageFetch =
  | { ok: true; bytes: Uint8Array; kind: ImageKind }
  | { ok: false; reason: string };

/**
 * Is this address one we must never ask our own network about?
 *
 * EVERY RANGE HERE IS A REAL TARGET, not a checklist. 127.0.0.0/8 and ::1 are this
 * process itself and anything it has bound; 169.254.0.0/16 is where cloud platforms
 * put the instance metadata service, which is the single most valuable thing an SSRF
 * can reach; 10/8, 172.16/12 and 192.168/16 are the private network the function sits
 * in; 100.64.0.0/10 is carrier NAT and routes inside some providers; fc00::/7 is the
 * IPv6 equivalent of private space and ::ffff:0:0/96 is how an IPv4 address is spelled
 * inside an IPv6 one, which is the spelling a denylist written in decimal misses.
 * 0.0.0.0 and :: mean "this host" to a surprising number of stacks.
 */
export function isForbiddenAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true; // Not an address at all: refuse rather than guess.
  if (v === 6) {
    const lower = ip.toLowerCase();
    // An IPv4 address written as IPv6 is still that IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isForbiddenAddress(mapped[1]);
    if (lower === '::1' || lower === '::') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7, unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10, link local
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Resolve a hostname and refuse it if ANY address it answers with is forbidden.
 *
 * ANY, not the first. A hostname can resolve to several addresses and a fetch may pick
 * a different one than a check did, so a host that answers with one public address and
 * one loopback address has to be refused outright. This narrows but does not close DNS
 * rebinding, where the answer changes between this check and the request: closing that
 * needs the connection pinned to the address that was checked, which `fetch` does not
 * expose. Stated because the next person should know which hole is still open.
 */
async function addressesAreSafe(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return !isForbiddenAddress(hostname);
  try {
    const all = await lookup(hostname, { all: true });
    if (all.length === 0) return false;
    return all.every((a) => !isForbiddenAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Everything that has to be true before the request is made.
 *
 * Exported so it can be exercised without a network, which is the only way the refusals
 * above get tested at all: a guard whose only proof is that a fetch did not happen is a
 * guard nobody can check.
 */
export function checkImageUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  /*
   * `safeExternalUrl` FIRST, because it already holds the scheme allowlist and the
   * control-character check - including the one that matters most here, that `new URL()`
   * strips tabs and newlines rather than refusing them. Re-deriving any of that here
   * would be a second opinion about what a safe URL is.
   */
  const safe = safeExternalUrl(raw);
  if (safe === null) return { ok: false, reason: 'not a usable address' };
  const url = new URL(safe);
  /*
   * HTTPS ONLY, which is narrower than `safeExternalUrl` allows. It permits `ipfs:`
   * because a link may be one; by the time an address reaches this fetcher the gateway
   * rewrite has already happened, so an `ipfs:` here means something skipped that step.
   */
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https is fetched' };
  // A port is how an internal service is usually reached. 443 or nothing.
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'only port 443 is fetched' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the address' };
  return { ok: true, url };
}

export async function fetchLaunchImage(
  raw: string,
  opts: { fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<boolean> } = {},
): Promise<ImageFetch> {
  const checked = checkImageUrl(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const url = checked.url;

  const resolve = opts.resolve ?? addressesAreSafe;
  if (!(await resolve(url.hostname))) return { ok: false, reason: 'address not permitted' };

  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url.toString(), {
      /*
       * MANUAL, AND A 3XX IS A REFUSAL. Following a redirect would fetch an address
       * that no check above has seen, which is the standard way a metadata endpoint is
       * reached past exactly this kind of allowlist. A logo that only resolves through
       * a redirect simply does not render.
       */
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'image/*' },
    });
  } catch (e) {
    return { ok: false, reason: `could not be fetched: ${(e as Error).message.slice(0, 80)}` };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'redirected' };
  if (!res.ok) return { ok: false, reason: `upstream answered ${res.status}` };

  /*
   * The declared length is a hint and is checked, but it is not trusted: a response may
   * omit it or lie, so the body is also truncated as it is read. Both, because the
   * header is the cheap refusal and the read is the real one.
   */
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'too large' };
  }

  const buf = await readCapped(res, MAX_IMAGE_BYTES);
  if (buf === null) return { ok: false, reason: 'too large' };
  if (buf.byteLength === 0) return { ok: false, reason: 'empty' };

  /*
   * The type comes from the BYTES. This is the whole reason the sniffer is shared: what
   * it returns is the `Content-Type` we assert, from our own origin, about somebody
   * else's bytes. Serving a creator's `text/html` from this domain would be stored
   * cross-site scripting that we performed on their behalf.
   */
  const kind = sniffImage(buf);
  if (!kind) return { ok: false, reason: 'not a PNG, JPEG, WEBP or GIF' };
  return { ok: true, bytes: buf, kind };
}

/** Read at most `cap` bytes, or null if the body runs past it. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.byteLength > cap ? null : whole;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
