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
  /**
   * What the token says it is, in the creator's words.
   *
   * TEXT, NOT A URL, which is why it is the one field here that never goes near
   * `safeExternalUrl`: "A token for cats" is not a URL and refusing it for not
   * starting with https would be absurd. It is rendered as text content and never
   * as markup, which is what keeps it safe.
   */
  description: string | null;
}

export const EMPTY_PROFILE: TokenProfile = {
  image: null,
  website: null,
  x: null,
  telegram: null,
  description: null,
};

/** Mirrors `MAX_URI_LEN` in the factory contract. */
export const MAX_URI_LEN = 256;

/** Mirrors `MAX_DESCRIPTION_LEN` in the factory contract. */
export const MAX_DESCRIPTION_LEN = 500;

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

/**
 * A fetchable URL for an image, or null when there is nothing safe to fetch.
 *
 * IT GOES THROUGH OUR OWN ORIGIN NOW. Audit F-03. This returned the creator's address
 * and every visitor's browser fetched it directly, which hands the creator's chosen
 * host the IP of everybody who so much as looks at their token, and leaves the bytes at
 * that address theirs to change after people have bought. `referrerPolicy="no-referrer"`
 * on the tag denied that host the referring URL; it never denied it the address.
 *
 * THE IPFS GATEWAY WAS THE SAME PROBLEM WITH A FRIENDLIER NAME, which the note above
 * already said: it "sees every request, so it learns which visitor looked at which
 * token". Routing it through the proxy too means that is now something this server
 * learns and ipfs.io does not. It is why the rewrite happens BEFORE the wrap rather
 * than instead of it.
 *
 * Retroactive by construction, and that is the point of proxying rather than re-hosting
 * at launch time: every launch already on chain is covered the moment this ships,
 * where copying bytes at creation could only ever help the launches made afterwards.
 * `imageFetch.ts` states plainly what that does and does not fix.
 */
export function imageSrc(raw: string | null | undefined): string | null {
  const safe = safeExternalUrl(raw);
  if (safe === null) return null;
  let target = safe;
  if (safe.startsWith('ipfs://')) {
    const cid = safe.slice('ipfs://'.length).replace(/^ipfs\//, '');
    // A CID with a path is fine; anything with a scheme in it is not, and would have
    // been refused above, so this only has to concatenate.
    if (cid.length === 0) return null;
    target = `${IPFS_GATEWAY}${cid}`;
  }
  /*
   * Encoded as a query parameter, so a creator cannot smuggle a second parameter in by
   * writing an `&` into their own URL and have the route read it as its own.
   */
  return `/api/img?u=${encodeURIComponent(target)}`;
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
  return {
    image: field('image'),
    website: field('website'),
    x: field('x'),
    telegram: field('telegram'),
    description: field('description'),
  };
}

/**
 * What the create form checks before building a transaction.
 *
 * Same rules as the contract, reported per field so the form can say which input is
 * wrong. Returns null when the value is acceptable.
 */
export function profileFieldError(raw: string, field = 'url'): string | null {
  if (raw.trim().length === 0) return null; // Absent is valid.
  /*
   * The description is prose and takes the prose rules. Checking it with the URL
   * rules would reject every real description, and the form would be telling a
   * creator to write their token's story as an https address.
   */
  if (field === 'description') return descriptionError(raw);
  if (raw.trim().length > MAX_URI_LEN) return `Keep this under ${MAX_URI_LEN} characters.`;
  if (safeExternalUrl(raw) === null) return 'Use a full https:// or ipfs:// address.';
  return null;
}

/** The same rules the contract applies to a description. Null when acceptable. */
export function descriptionError(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if ([...value].length > MAX_DESCRIPTION_LEN) {
    return `Keep this under ${MAX_DESCRIPTION_LEN} characters.`;
  }
  // Tab and newline are legitimate in prose; the rest of C0, DEL, and the bidi
  // overrides that let text render in an order it is not written in are not.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = (code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f;
    const bidi = code >= 0x202a && code <= 0x202e;
    if (control || bidi) return 'Remove the control characters.';
  }
  return null;
}

/** The profile as the contract expects it: absent fields omitted rather than empty. */
export function profileForChain(input: {
  image: string;
  website: string;
  x: string;
  telegram: string;
  description?: string;
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
