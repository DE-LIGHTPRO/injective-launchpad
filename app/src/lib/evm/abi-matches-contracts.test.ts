/**
 * Every function in the ABIs exists in the Solidity, with the same mutability.
 *
 * WHY THIS IS A SOURCE READ AND NOT A UNIT TEST. The ABIs are written out by hand
 * rather than imported from `evm/out`, because that directory is a build artifact and
 * gitignored, so importing it would make the app's build depend on someone having run
 * `forge build`. The cost of writing them out is drift: a function renamed in the
 * contract leaves the ABI naming something that no longer exists, and the only symptom
 * is a read returning nothing at runtime, on a page, in production.
 *
 * Nothing else can catch it. `tsc` type-checks the ABI against itself, viem trusts
 * what it is given, and the contracts' own Foundry tests never see this file. The
 * drift is between two repositories' worth of text that no compiler reads together.
 *
 * Caught by `prose-citations`, which failed because this file was cited in a comment
 * before it existed. That is the defect it describes, one level up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CURVE_ABI, FACTORY_ABI } from './abi.ts';

const EVM_SRC = join(import.meta.dirname, '..', '..', '..', '..', 'evm', 'src');

function source(file: string): string {
  const p = join(EVM_SRC, file);
  assert.ok(existsSync(p), `${p} is missing, so this guard would measure nothing`);
  return readFileSync(p, 'utf8');
}

/** Function names the contract declares, with their mutability. */
function declared(src: string): Map<string, string> {
  const out = new Map<string, string>();
  /*
   * The modifier list is ANY identifier, not a fixed keyword set.
   *
   * The first version alternated over external|public|view|pure|payable|override,
   * and `buy` is declared `external payable nonReentrant`. `nonReentrant` is a
   * user-defined modifier, so the match failed and the guard reported a function the
   * contract plainly has as missing. A guard whose false positives look exactly like
   * its true positives is worse than none, because the first one trains you to
   * ignore it.
   */
  for (const m of src.matchAll(
    /function\s+(\w+)\s*\([^)]*\)\s*([\w\s(),.[\]]*?)\s*[{;]/g,
  )) {
    const [, name, mods] = m;
    const mutability = /\bpayable\b/.test(mods)
      ? 'payable'
      : /\bview\b/.test(mods)
        ? 'view'
        : /\bpure\b/.test(mods)
          ? 'pure'
          : 'nonpayable';
    out.set(name, mutability);
  }
  return out;
}

/** Public state variables, which Solidity exposes as view getters. */
function publicVars(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s*(?:\w+(?:\[\])?|mapping\([^)]*\))\s+public\s+(?:immutable\s+|constant\s+)?(\w+)/gm)) {
    out.add(m[1]);
  }
  return out;
}

function check(abi: readonly { type: string; name?: string; stateMutability?: string }[], files: string[]) {
  const src = files.map(source).join('\n');
  const fns = declared(src);
  const vars = publicVars(src);

  const names = abi.filter((e) => e.type === 'function').map((e) => e.name!);
  assert.ok(names.length > 5, 'the ABI is nearly empty, so this guard measures nothing');

  for (const name of names) {
    const isFn = fns.has(name);
    const isVar = vars.has(name);
    assert.ok(isFn || isVar, `the ABI names \`${name}\`, which the contracts do not declare`);

    if (isFn) {
      const entry = abi.find((e) => e.name === name)!;
      const actual = fns.get(name)!;
      // `pure` and `view` are interchangeable for a caller; payable is not.
      const payableMismatch = (entry.stateMutability === 'payable') !== (actual === 'payable');
      assert.ok(
        !payableMismatch,
        `\`${name}\` is ${entry.stateMutability} in the ABI and ${actual} in the contract`,
      );
    }
  }
}

test('the factory ABI names only functions the factory has', () => {
  check(FACTORY_ABI as never, ['Factory.sol']);
});

test('the curve ABI names only functions the curve has', () => {
  check(CURVE_ABI as never, ['Curve.sol']);
});

test('the fees the app reads are the two the contract keeps apart', () => {
  /*
   * The specific drift that would hurt. A launch with 1% entry and 5% exit quoted at
   * the buy fee prices every sell 5% high, the seller's minimum comes from that
   * figure, and the contract refuses it as slippage. That defect is recorded on the
   * CosmWasm side and the Solidity port had it until the app's types named a field
   * the contracts did not have.
   */
  const names = CURVE_ABI.filter((e) => e.type === 'function').map((e) => e.name);
  assert.ok(names.includes('currentFeeBps'), 'the buy fee getter is missing from the ABI');
  assert.ok(names.includes('currentSellFeeBps'), 'the sell fee getter is missing from the ABI');
  assert.ok(names.includes('curveParams'), 'the curve shape getter is missing from the ABI');

  const src = source('Curve.sol');
  assert.match(src, /function currentSellFeeBps\(\)/, 'the contract lost its sell fee getter');
  assert.match(
    src,
    /quoteSell\(_cfg\(currentSellFeeBps\(\)\)/,
    'quoteSell no longer uses the sell fee, which is the original defect',
  );
});

/**
 * Errors the Solidity declares, with their argument types.
 *
 * `error Name(uint256 got, uint256 max)` yields `Name` -> `['uint256','uint256']`. The
 * parameter NAMES are dropped on purpose: a selector is keccak of the signature with
 * types only, so a renamed parameter changes nothing a caller can see, while a changed
 * type changes the selector and breaks decoding.
 */
function declaredErrors(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/^\s*error\s+(\w+)\s*\(([^)]*)\)/gm)) {
    const [, name, params] = m;
    const types = params
      .split(',')
      .map((p) => p.trim().split(/\s+/)[0])
      .filter((t) => t.length > 0);
    out.set(name, types);
  }
  return out;
}

/**
 * EVERY error the contracts can revert with is declared on the ABI, with the right
 * argument types.
 *
 * THE DEFECT THIS EXISTS FOR, and it had no symptom anywhere. The ABIs carried
 * functions and events and not one `error` entry. A Solidity custom error reaches the
 * client as four bytes of selector plus its arguments, and viem can only name it if
 * the ABI declares it - so every revert arrived as a bare "execution reverted" with
 * raw hex, and all seven branches in `errors.ts` that name a rule the curve enforces
 * were dead the day they were written. A trader refused for slippage, for the wallet
 * cap, or for trading not being open yet read a generic sentence while the contract
 * had explained itself precisely. Exactly the CosmWasm slippage branch that was dead
 * from the day it was written, one backend over.
 *
 * It was found by asking the chain, not by reading the code: `eth_call` of a buy with
 * an impossible floor returned `0x71c4efed…` and nothing in the app could say what
 * that was.
 *
 * THE LIBRARIES COUNT. `CurveMath` and `PoolMath` revert through the curve, so their
 * selectors land on a call to `buy` or `sell` and must be declared on the ABI that
 * call was made with. Checked against the union of the sources below for that reason.
 */
function checkErrors(
  abi: readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[],
  files: string[],
  label: string,
) {
  const errs = declaredErrors(files.map(source).join('\n'));
  assert.ok(errs.size > 5, `only ${errs.size} errors found in ${label}, so this measures nothing`);

  const onAbi = new Map(
    abi.filter((e) => e.type === 'error').map((e) => [e.name!, (e.inputs ?? []).map((i) => i.type)]),
  );

  for (const [name, types] of errs) {
    const declared = onAbi.get(name);
    assert.ok(
      declared !== undefined,
      `${label}: the contracts can revert with \`${name}\` and the ABI does not declare it, so viem cannot name it`,
    );
    assert.deepEqual(
      declared,
      types,
      `${label}: \`${name}\` takes (${types.join(', ')}) in the contract and (${declared.join(', ')}) on the ABI, which is a different selector`,
    );
  }

  // And nothing on the ABI that the contracts do not declare: a stale entry is a name
  // `errors.ts` could branch on and never reach.
  for (const name of onAbi.keys()) {
    assert.ok(
      errs.has(name),
      `${label}: the ABI declares \`${name}\`, which the contracts do not`,
    );
  }
}

test('the curve ABI declares every error the curve and its libraries can revert with', () => {
  checkErrors(CURVE_ABI as never, ['Curve.sol', 'CurveMath.sol', 'PoolMath.sol'], 'curve');
});

test('the factory ABI declares every error a creation can revert with', () => {
  checkErrors(
    FACTORY_ABI as never,
    ['Factory.sol', 'CurveMath.sol', 'LaunchToken.sol'],
    'factory',
  );
});
