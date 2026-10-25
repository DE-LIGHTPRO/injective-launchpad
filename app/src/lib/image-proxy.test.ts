import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';
import { checkImageUrl, fetchLaunchImage, isForbiddenAddress, MAX_IMAGE_BYTES } from './imageFetch.ts';
import { sniffImage } from './imageSniff.ts';

/**
 * Is the logo proxy safe to point at an address a stranger wrote on chain?
 *
 * AUDIT F-03 asked for the proxy; this file is about what the proxy introduces. A URL
 * fetcher driven by untrusted input is a server-side request forgery primitive: it
 * will fetch, from inside our own network, whatever a launch creator put in their
 * profile. On a serverless platform the valuable targets are the loopback interface and
 * the cloud metadata address at 169.254.169.254, and a plain `fetch` reaches both.
 *
 * Every refusal below is testable only because the address check and the URL check are
 * separate, pure, and exported. A guard whose only evidence is that a request did not
 * happen is a guard nobody can check, which is how this kind of code ships looking fine.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ok = async () => true;

function serves(body: Uint8Array, init: ResponseInit = {}) {
  return (async () => new Response(body as unknown as BodyInit, { status: 200, ...init })) as unknown as typeof fetch;
}

test('the addresses an SSRF would want are all refused', () => {
  /*
   * Each of these is a real target rather than a checklist entry. 169.254.169.254 is
   * the instance metadata service, which is the single most valuable thing an SSRF
   * reaches; 127.x and ::1 are this process and whatever it has bound; the private
   * ranges are the network the function sits in; 100.64/10 routes inside some
   * providers. `::ffff:127.0.0.1` is the spelling a denylist written in decimal misses.
   */
  for (const bad of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', '::FFFF:169.254.169.254',
    'not-an-address', '',
  ]) {
    assert.equal(isForbiddenAddress(bad), true, `${bad || '(empty)'} was permitted`);
  }
  // And ordinary public addresses are not refused, or the proxy serves nothing at all.
  for (const good of ['1.1.1.1', '8.8.8.8', '104.18.0.1', '172.32.0.1', '192.167.1.1', '2606:4700::1111']) {
    assert.equal(isForbiddenAddress(good), false, `${good} was refused, so no logo would load`);
  }
});

test('only an https address on the default port is ever fetched', () => {
  for (const bad of [
    'http://example.org/a.png',
    'https://example.org:8080/a.png',
    'https://user:pass@example.org/a.png',
    'ipfs://bafy/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    '//example.org/a.png',
    '/local/a.png',
  ]) {
    assert.equal(checkImageUrl(bad).ok, false, `${bad} passed the URL check`);
  }
  assert.equal(checkImageUrl('https://example.org/a.png').ok, true);
  assert.equal(checkImageUrl('https://example.org:443/a.png').ok, true);
});

test('a hostname whose addresses are not permitted is never requested', async () => {
  /*
   * The refusal has to happen BEFORE the request, so this asserts the fetch was not
   * called at all rather than that the result was empty. A check that runs after the
   * connection has already been made has not prevented anything.
   */
  let called = 0;
  const impl = (async () => {
    called += 1;
    return new Response(PNG as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  const r = await fetchLaunchImage('https://internal.example/a.png', {
    fetchImpl: impl,
    resolve: async () => false,
  });
  assert.equal(r.ok, false);
  assert.equal(called, 0, 'the request was made before the address was checked');
});

test('a redirect is refused rather than followed', async () => {
  /*
   * A redirect is a SECOND address that no check has seen, and following one is the
   * standard way a metadata endpoint is reached past exactly this kind of allowlist.
   */
  for (const status of [301, 302, 303, 307, 308]) {
    const impl = (async () => new Response(null, { status, headers: { location: 'https://169.254.169.254/' } })) as unknown as typeof fetch;
    const r = await fetchLaunchImage('https://example.org/a.png', { fetchImpl: impl, resolve: ok });
    assert.equal(r.ok, false, `a ${status} was followed`);
    assert.ok(!r.ok && /redirect/.test(r.reason), `a ${status} was not reported as a redirect`);
  }

  /*
   * AND THE SOURCE, BECAUSE THE MOCK ABOVE CANNOT SEE THE DIFFERENCE. A fake `fetch`
   * hands back whatever Response it was written to return and ignores the `redirect`
   * option entirely, so switching `manual` to `follow` left every assertion above
   * passing - it survived as a mutation. Against a real fetch that switch is the whole
   * hole: the redirect is chased before we ever see a 3xx, so the branch just proved
   * would never run, and the address it lands on is one no check has seen.
   *
   * There is no way to model that in a mock, so the option itself is asserted. A
   * fixture that cannot discriminate needs a second kind of evidence, not a better
   * fixture.
   */
  const src = maskComments(readFileSync(join(import.meta.dirname, 'imageFetch.ts'), 'utf8'));
  assert.match(src, /redirect:\s*'manual'/, 'the fetch follows redirects, so the 3xx guard above never runs');
  assert.doesNotMatch(src, /redirect:\s*'follow'/, 'something still asks fetch to follow redirects');
});

test('what is served is an image by its bytes, not by its header', async () => {
  /*
   * The type this returns becomes the `Content-Type` WE assert, from our own origin,
   * about somebody else's bytes. Serving a creator's `text/html` from this domain is
   * stored cross-site scripting performed on their behalf, so the header upstream sent
   * is not consulted at all.
   */
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  const lying = await fetchLaunchImage('https://example.org/a.png', {
    fetchImpl: serves(html, { headers: { 'content-type': 'image/png' } }),
    resolve: ok,
  });
  assert.equal(lying.ok, false, 'HTML was accepted because the upstream called it a PNG');

  const real = await fetchLaunchImage('https://example.org/a.png', {
    fetchImpl: serves(PNG, { headers: { 'content-type': 'text/plain' } }),
    resolve: ok,
  });
  assert.ok(real.ok, 'a genuine PNG was refused because the upstream mislabelled it');
  assert.equal(real.ok && real.kind.mime, 'image/png');
  assert.equal(sniffImage(html), null);
});

test('a body larger than the cap is refused, declared or not', async () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG.slice(0, 8));
  // Declared, the cheap refusal.
  const declared = await fetchLaunchImage('https://example.org/a.png', {
    fetchImpl: serves(PNG, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }),
    resolve: ok,
  });
  assert.equal(declared.ok, false, 'an oversized declared length was accepted');
  /*
   * And undeclared, which is the real one: a response may omit the header or lie, so
   * the body is truncated as it is read rather than trusted to be what it said.
   */
  const undeclared = await fetchLaunchImage('https://example.org/a.png', {
    fetchImpl: serves(big),
    resolve: ok,
  });
  assert.equal(undeclared.ok, false, 'an oversized body with no declared length was read in full');
  const empty = await fetchLaunchImage('https://example.org/a.png', { fetchImpl: serves(new Uint8Array()), resolve: ok });
  assert.equal(empty.ok, false);
});

test('the route tells a caller nothing it could probe with', () => {
  /*
   * The refusal reason is an oracle: "address not permitted" against "upstream answered
   * 500" tells whoever is probing which internal hostnames resolve, which is the
   * reconnaissance half of the attack the guards above exist against. It is logged and
   * not returned, and the renderer already draws a lettered fallback on any failure.
   */
  const route = maskComments(
    readFileSync(join(import.meta.dirname, '..', 'app', 'api', 'img', 'route.ts'), 'utf8'),
  );
  assert.match(route, /new NextResponse\(null, \{ status: 404 \}\)/, 'the route does not refuse blankly');
  /*
   * ASSERTED AS "NO BODY AT ALL", because the first version looked for `got.reason`
   * BEFORE a `NextResponse` and a mutation putting it after - the natural spelling,
   * `NextResponse.json({ reason: got.reason })` - sailed straight past it and survived.
   * An ordered pattern over two tokens is only as good as the order somebody happens to
   * write them in. This route has exactly two legitimate responses, bytes or nothing,
   * so the absence of a JSON body is the property, and it does not depend on spelling.
   */
  assert.doesNotMatch(
    route,
    /NextResponse\.json/,
    'the route returns a JSON body, which on its failure path is an oracle for probing internal hosts',
  );
  /*
   * The reason may be LOGGED and must not be RESPONDED WITH, and a blanket ban on the
   * symbol got that wrong: the first version forbade `got.reason` outright and failed
   * on the `console.error` this same test requires two lines down. Checked per line, so
   * it is order-independent without forbidding the logging that makes a real fault
   * visible.
   */
  const leaking = route
    .split('\n')
    .filter((l) => /NextResponse/.test(l) && /got\.reason/.test(l));
  assert.deepEqual(leaking, [], 'the refusal reason is put into a response');
  assert.match(route, /console\.error/, 'the reason is not even logged, so a real fault is invisible');
  assert.match(route, /allowUploadShared\([\s\S]*?bucket: 'broadcast'/, 'the proxy is unlimited');
  // The sniffed type, with nosniff on top of it.
  assert.match(route, /'content-type': got\.kind\.mime/, 'the route serves a type it did not sniff');
  assert.match(route, /x-content-type-options.*nosniff/, 'a browser may still sniff these bytes itself');
});

test('one sniffer, because two tables disagree about what an image is', () => {
  /*
   * The upload route had this table and the proxy needed the same answer. What the
   * sniffer returns is a stored `Content-Type` on one path and an asserted one on the
   * other, so a second copy is two opinions about the same bytes.
   */
  const upload = maskComments(
    readFileSync(join(import.meta.dirname, '..', 'app', 'api', 'upload', 'route.ts'), 'utf8'),
  );
  assert.match(upload, /sniffImage/, 'the upload route no longer uses the shared sniffer');
  assert.doesNotMatch(upload, /0x89.*0x50/, 'the upload route has its own magic-number table again');
  const proxy = maskComments(readFileSync(join(import.meta.dirname, 'imageFetch.ts'), 'utf8'));
  assert.match(proxy, /sniffImage/, 'the proxy does not sniff through the shared table');
  assert.doesNotMatch(proxy, /0x89.*0x50/, 'the proxy has its own magic-number table');
});
