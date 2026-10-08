/**
 * Token links, which are the one place a stranger's input becomes markup here.
 *
 * The factory contract validates these before storing them and that is the real guard.
 * These tests cover the second one, which exists because the UI can be pointed at a
 * different factory, because a launch stored before validation existed still
 * deserialises, and because `VITE_FACTORY_ADDRESS` is configuration rather than proof.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeExternalUrl,
  imageSrc,
  visibleLinks,
  parseProfile,
  profileFieldError,
  profileForChain,
  EMPTY_PROFILE,
  MAX_URI_LEN,
  IPFS_GATEWAY,
} from './tokenProfile.ts';

test('https and ipfs are the only schemes that survive', () => {
  assert.equal(safeExternalUrl('https://example.org/a.png'), 'https://example.org/a.png');
  assert.ok(safeExternalUrl('ipfs://bafyexample'));

  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://example.org',
    'blob:https://example.org/x',
    'about:blank',
  ]) {
    assert.equal(safeExternalUrl(bad), null, `accepted ${bad}`);
  }
});

test('a scheme-relative URL is refused rather than inheriting this page', () => {
  /*
   * `//evil.example/x` is a valid URL that resolves against the current page's scheme
   * and host-less origin, so pasting it into an href navigates off-site while reading
   * like a path. `new URL()` alone throws on it, which is the behaviour relied on here.
   */
  assert.equal(safeExternalUrl('//evil.example/x'), null);
  assert.equal(safeExternalUrl('/relative/path'), null);
  assert.equal(safeExternalUrl('example.org'), null);
});

test('a scheme split by a control character does not slip past the parser', () => {
  /*
   * The subtle one, and the reason control characters are checked BEFORE parsing.
   * `new URL()` strips tabs, newlines and carriage returns from a URL rather than
   * rejecting them, so `java\nscript:alert(1)` parses with `protocol === "javascript:"`
   * and a perfectly clean `href`. Checking the parser's output on an unchecked input
   * means checking a string the attacker has already had removed for them.
   */
  for (const bad of [
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'java\rscript:alert(1)',
    'jav\u0000ascript:alert(1)',
  ]) {
    assert.equal(safeExternalUrl(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  // And the plain form is still caught, so the control check is not doing all the work.
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
});

test('a quote or angle bracket in a URL is refused', () => {
  // Nothing legitimate needs them, and they are what break out of an attribute in
  // whatever renders this next, including somewhere that is not this app.
  for (const bad of [
    'https://example.org/"onerror=alert(1)',
    "https://example.org/'><script>",
    'https://example.org/<img>',
    'https://example.org/\\..\\x',
  ]) {
    assert.equal(safeExternalUrl(bad), null, `accepted ${bad}`);
  }
});

test('an overlong or empty value is nothing, not a link', () => {
  assert.equal(safeExternalUrl(''), null);
  assert.equal(safeExternalUrl('   '), null);
  assert.equal(safeExternalUrl(null), null);
  assert.equal(safeExternalUrl(undefined), null);
  assert.equal(safeExternalUrl(`https://e.org/${'a'.repeat(MAX_URI_LEN)}`), null);
});

test('an ipfs URI becomes a URL a browser can actually fetch', () => {
  /*
   * Browsers do not resolve `ipfs:` natively, so `<img src="ipfs://...">` renders
   * nothing at all: the link is valid, the image is blank, and nothing reports it.
   */
  const src = imageSrc('ipfs://bafyexample/logo.png');
  assert.equal(src, `${IPFS_GATEWAY}bafyexample/logo.png`);

  // https passes through untouched rather than being routed via a gateway.
  assert.equal(imageSrc('https://example.org/a.png'), 'https://example.org/a.png');
  // And a hostile value is still nothing.
  assert.equal(imageSrc('javascript:alert(1)'), null);
  assert.equal(imageSrc('ipfs://'), null);
});

test('only the links that are safe are offered for rendering', () => {
  const links = visibleLinks({
    image: null,
    website: 'https://example.org',
    x: 'javascript:alert(1)',
    telegram: 'https://t.me/example',
  });
  assert.deepEqual(
    links.map((l) => l.kind),
    ['website', 'telegram'],
    'a hostile link was offered for rendering',
  );
  assert.equal(visibleLinks(null).length, 0);
  assert.equal(visibleLinks(EMPTY_PROFILE).length, 0);
});

test('a launch with no profile field parses rather than throwing', () => {
  /*
   * A launch created before the contract carried a profile has no field at all, and a
   * launch from another factory may carry anything. One malformed token must not blank
   * the whole list, which is what an exception here would do.
   */
  assert.deepEqual(parseProfile(undefined), EMPTY_PROFILE);
  assert.deepEqual(parseProfile(null), EMPTY_PROFILE);
  assert.deepEqual(parseProfile('nonsense'), EMPTY_PROFILE);
  assert.deepEqual(parseProfile({ image: 42, website: ['x'] }), EMPTY_PROFILE);
  assert.deepEqual(parseProfile({ image: 'ipfs://a', website: 'https://b.org' }), {
    image: 'ipfs://a',
    website: 'https://b.org',
    x: null,
    telegram: null,
  });
});

test('the form reports a reason per field, and accepts a blank one', () => {
  assert.equal(profileFieldError(''), null, 'a blank field is a valid absent link');
  assert.equal(profileFieldError('   '), null);
  assert.equal(profileFieldError('https://example.org'), null);
  assert.match(profileFieldError('javascript:alert(1)') ?? '', /https:\/\/ or ipfs:\/\//);
  assert.match(profileFieldError(`https://e.org/${'a'.repeat(MAX_URI_LEN)}`) ?? '', /under 256/);
});

test('a blank field is sent as absent, never as an empty string', () => {
  /*
   * An empty string stored on chain renders as a link to the current page: it looks
   * like a working link, goes nowhere, and is permanent, because a profile is immutable.
   */
  const out = profileForChain({ image: '  ', website: 'https://example.org  ', x: '', telegram: '' });
  assert.deepEqual(out, { website: 'https://example.org' });
  assert.ok(!('image' in out), 'a blank field was sent');
  assert.deepEqual(profileForChain({ image: '', website: '', x: '', telegram: '' }), {});
});

test('a lookalike domain comes back as punycode, not as the lookalike', () => {
  /*
   * Why the PARSED href is returned rather than the string the creator typed.
   *
   * `https://exаmple.org` with a Cyrillic а is a different domain from
   * `https://example.org` and renders identically in every font. A launchpad is exactly
   * where that is worth something: a token page linking to what looks like a known site
   * is how a drainer gets its clicks.
   *
   * The URL parser punycodes it, so returning `parsed.href` means the link a visitor
   * reads is `xn--exmple-4nf.org`, which looks wrong because it IS wrong. Returning the
   * raw string would show them the lookalike. Measured, not assumed: Node gives
   * "https://xn--exmple-4nf.org/a".
   */
  const safe = safeExternalUrl('https://exаmple.org/a');
  assert.equal(safe, 'https://xn--exmple-4nf.org/a');
  assert.ok(!safe?.includes('а'), 'the Cyrillic character survived into the href');

  // Ordinary normalisation comes along with it, which is the same guarantee: what is
  // displayed is what the browser would actually navigate to.
  assert.equal(safeExternalUrl('https://EXAMPLE.org'), 'https://example.org/');
  assert.equal(safeExternalUrl('https://example.org/../x'), 'https://example.org/x');
});
