/**
 * Is this launch running the contract code this launchpad published, with no key
 * that can change it?
 *
 * NOT AN AUDIT, and no string here may say it is. `docs/AUDIT.md` begins "Not a
 * third-party audit". This compares three chain reads against configuration.
 *
 * WHY THE APP CHECKS. The factory admin can point FUTURE launches at a new curve code id
 * (`SetCurveCodeId`). That is how a fix ships, and it is also how a compromised admin
 * key would ship a curve that drains its reserve. Launches already created are safe
 * (curves have no wasm admin), but a launch created after a malicious repoint would look
 * identical on this board. So the page asks the chain what code each curve runs, and
 * compares it to the code ids the operator pinned at build time.
 *
 * Facts read from the chain, never from the contract's own answers about itself:
 *   - `code_id` and `admin` from `/cosmwasm/wasm/v1/contract/{addr}`. `admin` must be
 *     empty, or the "locked forever" claim on the page is false.
 *   - the code's `data_hash` from `/cosmwasm/wasm/v1/code/{id}`.
 *
 * WHY A HASH AND NOT JUST AN ID. A code id is immutable on CosmWasm - nothing can
 * replace the bytes stored under id 39974 - so comparing the id is not WEAKER than
 * comparing the hash on one chain. What it is, is unverifiable. "39974" is a pointer
 * whose meaning only the operator who uploaded it can vouch for; nobody reading this
 * repository can check what 39974 was supposed to contain. A hash can be rebuilt from
 * source and compared, and on 19 Oct 2026 it was:
 *
 *     chain code 39974 data_hash  3196401753e1cdcc520d7a370966804680f1fcbb03ef77dd8f9557c19053d9db
 *     shasum -a 256 curve.wasm   3196401753e1cdcc520d7a370966804680f1fcbb03ef77dd8f9557c19053d9db
 *
 * So the hash is what makes the word "published" on the launch page mean something, and
 * `verified` carries WHICH pin it satisfied so the copy cannot claim the stronger one on
 * the weaker evidence. A code id is also chain-scoped and a hash is not, which is the
 * second reason to prefer it: the same number means a different contract on mainnet.
 */

export interface ContractFacts {
  codeId: string;
  /**
   * The sha256 of the stored wasm, lowercase hex, or `null`/absent when unread. Unread
   * is not a mismatch: see `assessCurveCode`, where a pinned hash that could not be
   * checked yields `unknown` rather than either verdict.
   */
  codeHash?: string | null;
  /** Empty string when the contract has no admin, which is what the chain returns. */
  admin: string;
  /**
   * Who can mint the launched denom (tokenfactory authority), or `null` if unread.
   * Must be the curve itself: anyone else could mint without limit and sell into the
   * pool. The factory makes this so at launch; the page checks it rather than trusting.
   */
  denomAdmin?: string | null;
}

export type CodeStatus =
  /**
   * `pin` is WHICH evidence was satisfied, and the copy must not overstate it.
   * `'hash'` means the running bytes are the published bytes; `'code-id'` means only
   * that the id is one this build names, which nobody outside can check.
   */
  | { kind: 'verified'; codeId: string; pin: 'hash' | 'code-id' }
  /** Nothing pinned: a dev or pre-audit build. Not a warning to users, a hint to us. */
  | { kind: 'unpinned'; codeId: string }
  | { kind: 'unexpected-code'; codeId: string; expected: string[] }
  /**
   * The code id was pinned or irrelevant, and the BYTES are not the published bytes.
   * Separate from `unexpected-code` because the remedy differs: an unexpected id can be
   * a published upgrade nobody added to the list, where an unexpected hash under an
   * expected id cannot happen on an honest chain at all.
   */
  | { kind: 'unexpected-hash'; codeId: string; hash: string; expected: string[] }
  | { kind: 'has-admin'; admin: string }
  | { kind: 'mint-key-held'; holder: string }
  /** Could not be read. Says nothing either way, so it must not render as verified. */
  | { kind: 'unknown' };

/**
 * What this build vouches for. ONE OBJECT, not two parameters, because they are one
 * decision: a caller passing ids from one resolver and hashes from another is the
 * recurring defect here, and a single value cannot be half-passed.
 */
export interface CodePins {
  ids: string[];
  hashes: string[];
}

export function pinnedCodeIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s));
}

/**
 * Pinned code hashes, lowercased so a pin copied out of the LCD (which answers in upper
 * case) compares equal to one copied out of `shasum`. Anything that is not 64 hex
 * characters is dropped rather than kept as a pin that can never match: a truncated
 * hash would block every launch and read as a compromised chain.
 */
export function pinnedCodeHashes(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

export function assessCurveCode(
  facts: ContractFacts | null,
  pinned: CodePins,
  curve?: string,
): CodeStatus {
  if (!facts) return { kind: 'unknown' };
  // First, because it is the most direct drain: whoever holds it can mint and dump.
  // An unread value (`null`/`undefined`) is not evidence either way.
  if (curve && facts.denomAdmin != null && facts.denomAdmin !== curve) {
    return { kind: 'mint-key-held', holder: facts.denomAdmin };
  }
  // The admin check outranks everything below: known code that someone can replace is
  // not known code for long.
  if (facts.admin.trim() !== '') return { kind: 'has-admin', admin: facts.admin };
  /*
   * THE HASH IS AUTHORITATIVE WHERE IT IS PINNED, and the id is then not consulted.
   * Bytes that match what we published are what we published whatever id they were
   * stored under, so blocking on an id after the hash agreed would refuse a legitimate
   * re-upload of identical code.
   *
   * An unreadable hash against a pin is `unknown`: the same answer as unreadable facts,
   * for the same reason. It claims nothing, renders no badge, and does not block - a
   * flaky LCD is not evidence of a hostile contract, and treating it as one would make
   * every outage look like an attack.
   */
  if (pinned.hashes.length > 0) {
    /*
     * Lowercased here even though `codeHashOf` already promises lowercase. That is a
     * deliberate second normalisation, not an oversight: `ContractFacts` is a plain
     * interface anyone can build, and the chain answers in UPPER CASE, so a caller that
     * passes the LCD's string straight through would otherwise never match a pin.
     * Mutation-verified to be behaviour-neutral, which is why it carries no test of its
     * own - a guard for it would be testing this line against itself.
     */
    const hash = facts.codeHash?.toLowerCase();
    if (!hash) return { kind: 'unknown' };
    if (!pinned.hashes.includes(hash)) {
      return { kind: 'unexpected-hash', codeId: facts.codeId, hash, expected: pinned.hashes };
    }
    return { kind: 'verified', codeId: facts.codeId, pin: 'hash' };
  }
  if (pinned.ids.length === 0) return { kind: 'unpinned', codeId: facts.codeId };
  if (!pinned.ids.includes(facts.codeId)) {
    return { kind: 'unexpected-code', codeId: facts.codeId, expected: pinned.ids };
  }
  return { kind: 'verified', codeId: facts.codeId, pin: 'code-id' };
}

/** Whether trading should be offered at all. Unknown is allowed: a flaky LCD is not evidence. */
export function blocksTrading(s: CodeStatus): boolean {
  return (
    s.kind === 'unexpected-code' ||
    s.kind === 'unexpected-hash' ||
    s.kind === 'has-admin' ||
    s.kind === 'mint-key-held'
  );
}
