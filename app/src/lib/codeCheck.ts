/**
 * Is this launch running the contract code we audited, with no key that can change it?
 *
 * WHY THE APP CHECKS. The factory admin can point FUTURE launches at a new curve code id
 * (`SetCurveCodeId`). That is how a fix ships, and it is also how a compromised admin
 * key would ship a curve that drains its reserve. Launches already created are safe
 * (curves have no wasm admin), but a launch created after a malicious repoint would look
 * identical on this board. So the page asks the chain what code each curve runs, and
 * compares it to the code ids the operator pinned at build time.
 *
 * Two independent facts, both read from `/cosmwasm/wasm/v1/contract/{addr}`:
 *   - `code_id` must be one of `NEXT_PUBLIC_CURVE_CODE_IDS` (comma separated, so an
 *     audited upgrade can be added without dropping launches on the previous version);
 *   - `admin` must be empty, or the "locked forever" claim on the page is false.
 */

export interface ContractFacts {
  codeId: string;
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
  | { kind: 'verified'; codeId: string }
  /** Nothing pinned: a dev or pre-audit build. Not a warning to users, a hint to us. */
  | { kind: 'unpinned'; codeId: string }
  | { kind: 'unexpected-code'; codeId: string; expected: string[] }
  | { kind: 'has-admin'; admin: string }
  | { kind: 'mint-key-held'; holder: string }
  /** Could not be read. Says nothing either way, so it must not render as verified. */
  | { kind: 'unknown' };

export function pinnedCodeIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s));
}

export function assessCurveCode(
  facts: ContractFacts | null,
  pinned: string[],
  curve?: string,
): CodeStatus {
  if (!facts) return { kind: 'unknown' };
  // First, because it is the most direct drain: whoever holds it can mint and dump.
  // An unread value (`null`/`undefined`) is not evidence either way.
  if (curve && facts.denomAdmin != null && facts.denomAdmin !== curve) {
    return { kind: 'mint-key-held', holder: facts.denomAdmin };
  }
  // The admin check outranks the code id: audited code that someone can replace is
  // not audited code for long.
  if (facts.admin.trim() !== '') return { kind: 'has-admin', admin: facts.admin };
  if (pinned.length === 0) return { kind: 'unpinned', codeId: facts.codeId };
  if (!pinned.includes(facts.codeId)) {
    return { kind: 'unexpected-code', codeId: facts.codeId, expected: pinned };
  }
  return { kind: 'verified', codeId: facts.codeId };
}

/** Whether trading should be offered at all. Unknown is allowed: a flaky LCD is not evidence. */
export function blocksTrading(s: CodeStatus): boolean {
  return s.kind === 'unexpected-code' || s.kind === 'has-admin' || s.kind === 'mint-key-held';
}
