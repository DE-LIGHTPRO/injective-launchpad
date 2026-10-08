/**
 * Who a token says it is, and why none of it is trusted.
 *
 * A launchpad lets anyone attach an image and links to a token. Those values end up as
 * `src` and `href` in this app, which makes them the one place where a stranger's input
 * becomes markup. A `javascript:` URL in a token's "website" is script execution in this
 * origin, triggered by any visitor who clicks a link on a token page.
 *
 * The factory contract validates these before storing them, with an allowlist, and that
 * is the real guard. This is the second one, and it is not redundant:
 *
 *   - the UI can be pointed at a different factory, including one an attacker deployed
 *   - a launch stored before the contract validated anything still deserialises
 *   - `VITE_FACTORY_ADDRESS` is configuration, and configuration is not a proof
 *
 * Contract state is data, never markup, and the rule is that nothing here reaches an
 * attribute without passing `safeExternalUrl` first.
 */

export interface TokenProfile {
  image: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
}

export const EMPTY_PROFILE: TokenProfile = { image: null, website: null, x: null, telegram: null };

/** Mirrors `MAX_URI_LEN` in the factory contract. */
export const MAX_URI_LEN = 256;

/**
 * Schemes a token link may use.
 *
 * An ALLOWLIST, because a denylist has to anticipate every scheme a browser will ever
 * navigate, and the attacker only has to find one that was not anticipated. `javascript:`
 * is the obvious one; `data:text/html` is the same capability under another name, and
 * `vbscript:` still works in some embedded webviews.
 */
const ALLOWED_SCHEMES = ['https:', 'ipfs:'] as const;

/**
 * Returns the URL if it is safe to put in an attribute, and null otherwise.
 *
 * Null rather than a thrown error or a sanitised string: a link that cannot be shown is
 * simply not shown, and silently "fixing" a hostile URL into a working one is how a
 * sanitiser becomes the vulnerability.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_URI_LEN) return null;

  /*
   * Control characters are checked BEFORE parsing, because `new URL()` strips tabs and
   * newlines rather than rejecting them: `java\nscript:alert(1)` parses to a
   * `javascript:` URL with a clean `protocol`, so a check that trusts the parser's
   * output on an unchecked input is checking something the attacker already removed.
   */
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>"'\\]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Relative, scheme-less, or malformed. A token link is absolute or it is nothing;
    // `//evil.example` would otherwise inherit this page's scheme.
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol as (typeof ALLOWED_SCHEMES)[number])) return null;

  // `href` is the parser's normalised form, which is what the browser would navigate
  // to anyway. Returning the raw string would let the two disagree.
  return parsed.href;
}

/**
 * An `ipfs://` URI is not a URL a browser can fetch.
 *
 * Browsers do not resolve `ipfs:` natively, so an `<img src="ipfs://...">` renders
 * nothing. A gateway is needed, and which gateway is a real decision rather than a
 * detail: it sees every request, so it learns which visitor looked at which token.
 * Named in one place so it can be changed in one place, and so that nobody has to
 * discover it by reading an image tag.
 */
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** A fetchable URL for an image, or null when there is nothing safe to fetch. */
export function imageSrc(raw: string | null | undefined): string | null {
  const safe = safeExternalUrl(raw);
  if (safe === null) return null;
  if (safe.startsWith('ipfs://')) {
    const cid = safe.slice('ipfs://'.length).replace(/^ipfs\//, '');
    // A CID with a path is fine; anything with a scheme in it is not, and would have
    // been refused above, so this only has to concatenate.
    return cid.length > 0 ? `${IPFS_GATEWAY}${cid}` : null;
  }
  return safe;
}

/** The links that are actually safe to render, in the order they should appear. */
export function visibleLinks(
  profile: TokenProfile | null | undefined,
): Array<{ kind: 'website' | 'x' | 'telegram'; label: string; href: string }> {
  if (!profile) return [];
  const out: Array<{ kind: 'website' | 'x' | 'telegram'; label: string; href: string }> = [];
  const add = (kind: 'website' | 'x' | 'telegram', label: string, raw: string | null) => {
    const href = safeExternalUrl(raw);
    if (href !== null) out.push({ kind, label, href });
  };
  add('website', 'Website', profile.website);
  add('x', 'X', profile.x);
  add('telegram', 'Telegram', profile.telegram);
  return out;
}

/**
 * Normalises whatever a query returned into a profile.
 *
 * A launch created before the contract carried a profile has no field at all, and a
 * launch from a different factory may have anything. Unknown shapes become nulls rather
 * than throwing, because one malformed token must not blank the whole list.
 */
export function parseProfile(raw: unknown): TokenProfile {
  if (raw === null || typeof raw !== 'object') return EMPTY_PROFILE;
  const o = raw as Record<string, unknown>;
  const field = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return { image: field('image'), website: field('website'), x: field('x'), telegram: field('telegram') };
}

/**
 * What the create form checks before building a transaction.
 *
 * Same rules as the contract, reported per field so the form can say which input is
 * wrong. Returns null when the value is acceptable.
 */
export function profileFieldError(raw: string): string | null {
  if (raw.trim().length === 0) return null; // Absent is valid.
  if (raw.trim().length > MAX_URI_LEN) return `Keep this under ${MAX_URI_LEN} characters.`;
  if (safeExternalUrl(raw) === null) return 'Use a full https:// or ipfs:// address.';
  return null;
}

/** The profile as the contract expects it: absent fields omitted rather than empty. */
export function profileForChain(input: {
  image: string;
  website: string;
  x: string;
  telegram: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const value = raw.trim();
    // Empty is sent as absent. An empty string would be stored and would render as a
    // link to the current page, which looks like a working link and is not one.
    if (value.length > 0) out[key] = value;
  }
  return out;
}
