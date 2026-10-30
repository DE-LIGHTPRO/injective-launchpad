/**
 * Translating an EVM failure into a sentence, and keeping the raw text for a developer.
 *
 * THE DEFECT THIS EXISTS FOR, measured on the running EVM build. A buy was refused and
 * the dialog showed the user, verbatim:
 *
 *     The Provider does not support the requested method. Request Arguments: chain:
 *     Injective EVM (id: 1776) from: 0x7fCc… to: 0x1EA8… value: 0.001 INJ data:
 *     0x7deb602500000000000000000000000000000000000000000000076bc42623e67de8232100…
 *     Contract Call: address: 0x1EA8… function: buy(uint256 minTokensOut, address
 *     recipient) args: (35044501019927849214753, 0x0000…) sender: 0x7fCc…
 *     Docs: https://viem.sh/docs/contract/writeContract Details: …
 *     Version: viem@2.21.54
 *
 * Calldata, an ABI signature, a docs link and a library version number, on a trading
 * screen, to somebody who pressed Buy. The CosmWasm path has had
 * `describeBroadcastFailure` for exactly this since a node error reached a user once;
 * the EVM path passed its provider's text straight through.
 *
 * MATCHED ON THE CONTRACT'S OWN ERROR NAMES. The curve reverts with custom errors
 * (`SlippageExceeded`, `OverWalletCap`, `NotStarted`, `NothingToClaim`) and viem puts
 * the decoded name in the message, so these are matched rather than guessed from
 * substrings of English. `app/src/lib/evm/error-copy.test.ts` reads the names out of
 * `evm/src/Curve.sol`, so an error renamed in the contract fails there instead of
 * silently going generic here.
 *
 * A CURVE REFUSING A TRADE ON ITS OWN TERMS IS NOT A FAILURE, which is the distinction
 * the CosmWasm translator records: "the chain refused the transaction" over a correct,
 * deliberate contract rule reads as a bug and sends the user looking for one.
 */

/** Everything a provider or viem might carry the text on. */
export function evmErrorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as {
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
      metaMessages?: unknown;
    };
    const parts = [o.shortMessage, o.details, o.message]
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    /*
     * The CAUSE as well as the message. viem wraps a revert in a
     * `ContractFunctionExecutionError` whose own `message` is the formatted block
     * above, while the decoded custom error name sits on the cause. Matching the
     * outer message alone missed every single contract rule.
     */
    if (o.cause) parts.push(evmErrorText(o.cause));
    if (Array.isArray(o.metaMessages)) {
      parts.push(...o.metaMessages.filter((m): m is string => typeof m === 'string'));
    }
    if (parts.length > 0) return [...new Set(parts)].join('\n');
    /*
     * AN OBJECT WITH NONE OF THOSE FIELDS IS STILL NOT `[object Object]`, which is
     * what `String(e)` produces and which this returned until a test asked. That exact
     * text has reached users on this codebase before, from an upstream error passed
     * straight to `new Error()`, and it is the one string that tells a reader nothing
     * at all while looking like a crash. A provider can reject with a bare
     * `{code, data}`, so this is reachable rather than defensive.
     */
    try {
      return JSON.stringify(e);
    } catch {
      // A circular object, which `JSON.stringify` throws on. Nothing useful is left.
      return 'the wallet returned an error with no readable text';
    }
  }
  return String(e ?? '');
}

/**
 * The decoded custom error, read off the object rather than out of the message.
 *
 * MEASURED, BECAUSE THE FORMATTED TEXT DOES NOT CARRY THE VALUES. The first version
 * matched `/SlippageExceeded\((\d+),\s*(\d+)\)/` on viem's message, on the
 * assumption that a decoded error renders with its arguments. It does not: against
 * the live curve on 30 Oct 2026, a buy with an impossible floor produced
 *
 *     Error: SlippageExceeded(uint256 got, uint256 wanted)
 *
 * which is the SIGNATURE, with parameter names where the numbers would be. So the
 * regex never fired and a trader got the branch with no figures in it, while the
 * values sat on `cause.data.args` as `[35398485878714999206822n, 1e30n]`.
 *
 * Walking the cause chain rather than reading one level: viem throws a
 * `ContractFunctionExecutionError` whose `data` is undefined and puts the decoded
 * revert on its cause. A deeper nesting is possible, so this looks until it finds one.
 * The same "providers disagree on shape, so read it structurally" rule the upstream
 * error describer follows.
 */
function decodedRevert(e: unknown): { name: string; args: readonly unknown[] } | null {
  let node: unknown = e;
  for (let depth = 0; node && depth < 8; depth++) {
    const d = (node as { data?: { errorName?: unknown; args?: unknown } }).data;
    if (d && typeof d.errorName === 'string') {
      return { name: d.errorName, args: Array.isArray(d.args) ? d.args : [] };
    }
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

/** A decoded uint256 argument as a readable 18-decimal amount, or null. */
function arg18(args: readonly unknown[], i: number): string | null {
  const v = args[i];
  return typeof v === 'bigint' ? format18(v.toString()) : null;
}

/** 18-decimal base units as a readable amount. The launched token's scale. */
function format18(raw: string): string {
  try {
    const v = BigInt(raw);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
    return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
  } catch {
    return raw;
  }
}

export interface EvmFailure {
  /** What the user reads. Never a provider's own words. */
  message: string;
  /** The provider's own words, for a dev build. Always kept. */
  detail: string;
  /** `true` when the user closed the prompt, which is a choice and not a fault. */
  rejected: boolean;
}

export function describeEvmFailure(e: unknown): EvmFailure {
  const raw = evmErrorText(e);
  const code = (e as { code?: number } | null)?.code;
  const s = raw.toLowerCase();
  const out = (message: string, rejected = false): EvmFailure => ({ message, detail: raw, rejected });

  /*
   * A CLOSED PROMPT IS NOT AN ERROR. 4001 is EIP-1193's own code for it; the text is
   * matched too because a wallet can wrap the rejection and lose the code on the way.
   */
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(raw)) {
    return out('You closed the wallet prompt, so nothing was sent.', true);
  }

  /*
   * THE CURVE'S OWN RULES, FROM THE DECODED REVERT. Read off the object first, so the
   * arguments are available: a slippage refusal that does not say which way the price
   * moved or by how much leaves a trader guessing at amounts. The name-only branches
   * below are the fallback for a provider that gives the name in text and nothing
   * structural, which is why both exist.
   */
  const dec = decodedRevert(e);
  if (dec?.name === 'SlippageExceeded') {
    const got = arg18(dec.args, 0);
    const wanted = arg18(dec.args, 1);
    if (got !== null && wanted !== null) {
      return out(
        `The price moved before this landed: the curve would give ${got} and you asked for at least ${wanted}. Try again, or raise your slippage tolerance.`,
      );
    }
  }
  if (dec?.name === 'OverWalletCap') {
    const wanted = arg18(dec.args, 0);
    const allowance = arg18(dec.args, 1);
    if (wanted !== null && allowance !== null) {
      return out(
        `This launch caps how much one address can buy from the curve, and this buy of ${wanted} is over what is left. You can buy at most ${allowance} more. Selling frees the allowance again.`,
      );
    }
  }
  /*
   * `named` tests the decoded name AND the text. The text alone was the whole test
   * before, and viem does put the name in the message - but a provider that returns
   * only structured data would have matched nothing, and nothing would have said so.
   */
  const named = (n: string) => dec?.name === n || new RegExp(`\\b${n}\\b`).test(raw);

  if (named('SlippageExceeded')) {
    return out('The price moved past your slippage tolerance before this landed. Try again.');
  }
  if (named('OverWalletCap')) {
    return out(
      'This launch caps how much one address can buy from the curve, and this buy is over it. Selling frees the allowance again.',
    );
  }
  if (named('NotStarted')) {
    return out(
      'Buying is not open on this launch yet. The curve gates on block time, so try again once the start time has passed.',
    );
  }
  if (named('AlreadyGraduated')) {
    return out(
      'This launch graduated while the trade was in flight. Reload the page to trade against the locked pool instead.',
    );
  }
  if (named('NothingToClaim')) {
    return out('There is nothing left to claim: these fees have already been paid out.');
  }
  if (named('NotReady')) {
    return out('This launch has not reached its graduation target yet, so there is nothing to migrate.');
  }
  if (named('ZeroAmount')) {
    return out('That amount is too small for the curve to price. Try a larger one.');
  }
  if (named('Graduated')) {
    return out('The curve is closed on this launch. Reload the page to trade against its locked pool.');
  }
  if (named('InsufficientCurveSupply')) {
    return out('There is not enough left on the curve to fill that. Try a smaller amount.');
  }
  if (named('TransferFailed')) {
    return out('The token transfer was refused. Nothing was spent beyond the fee.');
  }
  if (named('InsufficientSold')) {
    return out('That is more than the curve has sold, so it cannot be sold back.');
  }

  // ERC-20, which a sell can hit between the approval and the sale.
  if (/insufficient allowance|ERC20InsufficientAllowance/i.test(raw)) {
    return out(
      'The curve is not allowed to take that many tokens. Approve the sale again and retry.',
    );
  }
  if (/ERC20InsufficientBalance|transfer amount exceeds balance/i.test(raw)) {
    return out('That is more than this wallet holds.');
  }

  /*
   * MEASURED WORDING, not assumed. Injective's EVM reports a shortfall as
   *
   *     rpc error: code = Internal desc = insufficient balance for transfer
   *
   * which contains neither "insufficient funds" nor "exceeds balance" - the two
   * phrases every other EVM chain uses and the only ones this branch tested for. A
   * wallet with 0.008 INJ pressing a 1 INJ buy therefore fell all the way through to
   * the catch-all sentence, on the one failure where naming the cause is most useful.
   * Observed against `sentry.evm-rpc.injective.network`, 30 Oct 2026.
   */
  if (
    s.includes('insufficient funds') ||
    s.includes('insufficient balance') ||
    s.includes('exceeds balance')
  ) {
    return out('Not enough INJ in this wallet to cover the amount plus gas.');
  }
  if (s.includes('nonce too low') || s.includes('already known') || s.includes('replacement')) {
    return out('Another transaction from this account is still settling. Wait a moment and try again.');
  }
  if (s.includes('intrinsic gas too low') || s.includes('out of gas')) {
    return out('The transaction ran out of gas. Try again: the limit is measured again each time.');
  }
  if (/\b4902\b|unrecognized chain|unrecognised chain/i.test(raw)) {
    return out('The wallet is not on Injective EVM. Switch networks in the wallet and try again.');
  }
  if (code === 4200 || s.includes('does not support the requested method')) {
    return out('This wallet cannot sign transactions on Injective EVM.');
  }
  if (s.includes('execution reverted')) {
    /*
     * A revert with nothing decodable. Still not "the chain refused" with no further
     * word: the useful half is that nothing was spent beyond the fee, which is the
     * first thing a trader wants to know.
     */
    return out(
      'The curve refused the trade. Nothing moved and nothing was spent beyond the fee. Reload the page: the figures it was priced against may have changed.',
    );
  }

  return out(
    'The transaction did not go through. Nothing was spent beyond the fee, if anything was sent at all.',
  );
}
