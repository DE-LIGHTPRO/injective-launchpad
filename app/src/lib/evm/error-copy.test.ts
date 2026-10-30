/**
 * No provider's own words reach a user, and every rule the curve enforces is named.
 *
 * THE DEFECT, MEASURED ON THE RUNNING BUILD. A buy was refused on the EVM backend and
 * the dialog printed viem's formatted error whole: calldata, the ABI signature of
 * `buy(uint256,address)`, a `https://viem.sh` docs link and `Version: viem@2.21.54`.
 * Nothing translated it, because the EVM path was added after
 * `describeBroadcastFailure` and never routed through anything like it.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT ROTS. The first is that the copy is
 * written for a reader. The second is that it is keyed on the error names the CONTRACT
 * declares, so this file reads them out of `evm/src/Curve.sol`: an error renamed there
 * fails here rather than quietly falling through to the generic sentence, which is
 * exactly how the CosmWasm slippage branch stayed dead from the day it was written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeEvmFailure, evmErrorText } from './errors.ts';

const CURVE_SOL = join(import.meta.dirname, '..', '..', '..', '..', 'evm', 'src', 'Curve.sol');

/**
 * Errors the curve can revert a TRADE OR A CLAIM with.
 *
 * Not every error the file declares: `TransferFailed` and the rest are covered too,
 * but these are the ones a user reaches by pressing a button, so a generic sentence
 * for one of them is the failure this guard is about.
 */
const USER_FACING = [
  'NotStarted',
  'SlippageExceeded',
  'NothingToClaim',
  'OverWalletCap',
  'AlreadyGraduated',
  'ZeroAmount',
  'NotReady',
];

test('every user-facing error in Curve.sol is still declared under that name', () => {
  const src = readFileSync(CURVE_SOL, 'utf8');
  const declared = new Set(
    [...src.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1]),
  );
  for (const name of USER_FACING) {
    assert.ok(
      declared.has(name),
      `Curve.sol no longer declares ${name}, so the branch in errors.ts keyed on it is dead`,
    );
  }
});

/**
 * A revert shaped the way viem ACTUALLY throws one.
 *
 * MEASURED, AND IT IS NOT WHAT I ASSUMED. The first version of this test built
 * `new Error('Error: SlippageExceeded()')`, which is roughly what viem's formatted
 * message contains, and every assertion passed. Against the live curve on
 * 30 Oct 2026 viem throws a `ContractFunctionExecutionError` whose own `data` is
 * undefined, with the decoded revert on its CAUSE:
 *
 *     cause.name           ContractFunctionRevertedError
 *     cause.data.errorName SlippageExceeded
 *     cause.data.args      [35398485878714999206822n, 1000000000000000000000000000000n]
 *
 * and its message renders the SIGNATURE, `SlippageExceeded(uint256 got, uint256
 * wanted)`, with parameter names where the numbers would be. So a test built on a
 * hand-written string can pass while the branch it covers cannot fire - which is what
 * happened: the ABIs carried no `error` entries at all, so viem could not decode a
 * single one of these names, and every assertion here was green over seven dead
 * branches. The fixture has to be the shape the chain produces.
 */
function viemRevert(name: string, args: readonly unknown[] = []) {
  const inner = Object.assign(
    new Error(`The contract function "buy" reverted.\n\nError: ${name}(…)`),
    { name: 'ContractFunctionRevertedError', data: { errorName: name, args } },
  );
  return Object.assign(new Error('The contract function "buy" reverted.'), { cause: inner });
}

test('each one gets its own sentence, not the generic refusal', () => {
  const generic = describeEvmFailure(new Error('something nobody has seen')).message;
  for (const name of USER_FACING) {
    const f = describeEvmFailure(viemRevert(name));
    assert.notEqual(f.message, generic, `${name} falls through to the generic sentence`);
    assert.ok(f.message.length > 20, `${name} has no real sentence`);
  }
});

test('every layer a provider might carry the text on is read', () => {
  /*
   * `evmErrorText` is what keeps the raw detail complete, and it has to reach the
   * cause and the metaMessages: viem puts the formatted block on one and the request
   * arguments on the other, and the detail is the only thing that identifies an
   * unrecognised failure - the lesson `WalletError.detail` was added for.
   */
  const e = Object.assign(new Error('outer'), {
    shortMessage: 'short',
    details: 'detail line',
    metaMessages: ['meta one', 'meta two'],
    cause: new Error('from the cause'),
  });
  const t = evmErrorText(e);
  for (const part of ['short', 'detail line', 'outer', 'from the cause', 'meta one', 'meta two']) {
    assert.ok(t.includes(part), `evmErrorText dropped "${part}"`);
  }
  // A plain string and a non-error both come back as something, never "[object Object]".
  assert.equal(evmErrorText('just a string'), 'just a string');
  assert.ok(!evmErrorText({ nothing: 1 }).includes('[object Object]'));
});

test('the decoded name is enough on its own, with nothing readable in the text', () => {
  /*
   * A provider that returns structured data and an unhelpful message. The branches
   * tested the MESSAGE only before, so this would have fallen through every one of
   * them - and viem does put the name in the message today, which is exactly what
   * makes a text-only test look sufficient.
   */
  const bare = Object.assign(new Error('execution reverted'), {
    cause: Object.assign(new Error('execution reverted'), {
      data: { errorName: 'NotStarted', args: [] },
    }),
  });
  assert.match(describeEvmFailure(bare).message, /not open on this launch yet/);
});

test('the user never reads calldata, an ABI signature, a docs link or a version', () => {
  /*
   * The exact text that reached a user on the running build, kept verbatim. If the
   * translation is ever removed or bypassed, this is what comes back.
   */
  const real = Object.assign(
    new Error(
      'The Provider does not support the requested method.\n' +
        'Request Arguments:\n  chain: Injective EVM (id: 1776)\n' +
        '  from: 0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb\n' +
        '  to: 0x1EA823E09dB42Ca472182D8898bfaA40A64020F9\n' +
        '  value: 0.001 INJ\n' +
        '  data: 0x7deb602500000000000000000000000000000000000000000000076bc42623e67de82321\n' +
        'Contract Call:\n  function: buy(uint256 minTokensOut, address recipient)\n' +
        'Docs: https://viem.sh/docs/contract/writeContract\n' +
        'Version: viem@2.21.54',
    ),
    { code: 4200 },
  );
  const f = describeEvmFailure(real);

  for (const leak of ['0x7deb6025', 'viem.sh', 'viem@', 'uint256', 'Request Arguments', 'Docs:']) {
    assert.ok(!f.message.includes(leak), `the user is shown "${leak}"`);
  }
  // Said in a sentence, about this wallet, rather than about a JSON-RPC method.
  assert.match(f.message, /wallet/i);

  /*
   * THE RAW TEXT IS KEPT, not thrown away. `TxDialog` shows it in a dev build only,
   * and discarding it is what made a real Keplr failure undiagnosable on the other
   * backend - the lesson `WalletError.detail` was added for.
   */
  assert.ok(f.detail.includes('0x7deb6025'));
  assert.ok(f.detail.includes('viem@2.21.54'));
});

test('a closed prompt is a choice, by code and by wording', () => {
  const byCode = describeEvmFailure(Object.assign(new Error('nope'), { code: 4001 }));
  assert.equal(byCode.rejected, true);
  assert.match(byCode.message, /closed the wallet prompt/);

  // A wallet that wraps the rejection and loses the code still has to be recognised,
  // or a user who declined is told their transaction failed.
  const byText = describeEvmFailure(new Error('MetaMask Tx Signature: User rejected the request.'));
  assert.equal(byText.rejected, true);

  assert.equal(describeEvmFailure(new Error('execution reverted')).rejected, false);
});

test('slippage names both numbers, read off the args and not out of the text', () => {
  /*
   * THE EXACT VALUES THE LIVE CURVE RETURNED for a buy with a 1e30 floor. The message
   * carries the signature and no figures, so these can only come from `data.args` -
   * and "the price moved" without them leaves a trader guessing which way and by how
   * much, which is the half that makes the sentence actionable.
   */
  const f = describeEvmFailure(
    viemRevert('SlippageExceeded', [35398485878714999206822n, 1000000000000000000000000000000n]),
  );
  assert.match(f.message, /35,398\.4858/);
  assert.match(f.message, /1,000,000,000,000/);
  assert.match(f.message, /slippage|price moved/i);

  // And with the args missing it still says something useful rather than "undefined".
  const noArgs = describeEvmFailure(viemRevert('SlippageExceeded'));
  assert.match(noArgs.message, /slippage tolerance/);
  assert.ok(!noArgs.message.includes('undefined'));
  assert.ok(!noArgs.message.includes('null'));
});

test('the wallet cap says how much is left, because that is the actionable half', () => {
  const f = describeEvmFailure(
    viemRevert('OverWalletCap', [6000000000000000000000000n, 1500000000000000000000000n]),
  );
  assert.match(f.message, /6,000,000/);
  assert.match(f.message, /1,500,000/);
  assert.match(f.message, /Selling frees the allowance/);
});

test("a shortfall is named with Injective's own wording", () => {
  /*
   * MEASURED, 30 Oct 2026. Injective's EVM says
   *
   *     rpc error: code = Internal desc = insufficient balance for transfer
   *
   * which contains neither "insufficient funds" nor "exceeds balance", the two phrases
   * the branch originally tested for. A wallet holding 0.008 INJ pressing a 1 INJ buy
   * fell through to the catch-all, on the one refusal where naming the cause helps
   * most - and it is the refusal the new pre-flight simulation now catches for free,
   * so it is the one users will see.
   */
  const f = describeEvmFailure(
    new Error('rpc error: code = Internal desc = insufficient balance for transfer'),
  );
  assert.match(f.message, /Not enough INJ/);
  // The other chains' phrasings must keep working: this is an addition, not a swap.
  assert.match(describeEvmFailure(new Error('insufficient funds for gas')).message, /Not enough INJ/);
});

test('an undecodable revert still says nothing was spent', () => {
  const f = describeEvmFailure(new Error('execution reverted'));
  assert.match(f.message, /refused/i);
  // The first thing a trader wants to know, and the thing the ErrorBoundary copy rule
  // asks for on every refusal: whether their money moved.
  assert.match(f.message, /nothing was spent|Nothing moved/i);
});
