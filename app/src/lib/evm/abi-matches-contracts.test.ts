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

/**
 * Events the Solidity declares, with their types AND which of them are indexed.
 *
 * `indexed` is not decoration: an indexed argument travels in `topics` and an
 * unindexed one in `data`, so getting it wrong does not fail - it reads the wrong
 * bytes as the wrong field, and a trade feed shows plausible nonsense.
 */
function declaredEvents(src: string): Map<string, Array<{ type: string; indexed: boolean }>> {
  const out = new Map<string, Array<{ type: string; indexed: boolean }>>();
  /*
   * MULTI-LINE DECLARATIONS ARE THE COMMON CASE HERE. `Factory.sol` declares
   * `LaunchCreated` across eight lines, and `Curve.sol`'s are single-line.
   *
   * Checked rather than assumed, because I nearly left a false claim here: when this
   * guard first failed I wrote that `[^)]*` had skipped `LaunchCreated` and "fixed"
   * the pattern. Running both against the source says otherwise - `[^)]*` matches
   * newlines, and both patterns find all five of the factory's events. The failure was
   * mine: I had asserted contract-subset-of-ABI for the factory, which demanded four
   * admin events no screen reads. `[\s\S]*?` with the `;` anchor is kept as a
   * tightening (it cannot run past a declaration into the next one), not as a fix for
   * something that was broken.
   */
  for (const m of src.matchAll(/^\s*event\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gm)) {
    const [, name, params] = m;
    const args = params
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => ({ type: p.split(/\s+/)[0], indexed: /\bindexed\b/.test(p) }));
    out.set(name, args);
  }
  return out;
}

/** The event shapes an ABI declares, in the same form `declaredEvents` returns. */
function eventShapes(
  abi: readonly { type: string; name?: string; inputs?: readonly { type: string; indexed?: boolean }[] }[],
): Map<string, Array<{ type: string; indexed: boolean }>> {
  return new Map(
    abi
      .filter((e) => e.type === 'event')
      .map((e) => [
        e.name!,
        (e.inputs ?? []).map((i) => ({ type: i.type, indexed: i.indexed === true })),
      ]),
  );
}

/**
 * EVERY event the curve emits is declared on the ABI, with the right shape.
 *
 * THE DEFECT, AND IT IS THE MISSING-ERRORS DEFECT AGAIN ONE FILE LATER. The ABI
 * carried functions and nothing else. A log reaches the client as a topic hash plus
 * data, and viem can only name it if the ABI declares the event - so
 * `parseEventLogs` returned an empty array for every log it was handed, and
 * `evm/trades.ts` reported zero trades for a launch whose own state says it has
 * traded. It reported that over a window it genuinely had read, which is the worst
 * version: a measured-looking absence.
 *
 * Measured on the live PAD curve, 30 Oct 2026: `eth_getLogs` over the page after its
 * creation returns one log, and with the events declared the reader decodes it as a
 * buy of 0.004 INJ for 141,617.306 tokens with a 0.00004 INJ fee - every figure
 * matching what the page already showed from the curve's own state.
 *
 * I had written a test for the trade reader that fed it already-decoded shapes. It
 * would have passed over a reader that could never decode anything, which is exactly
 * the trap the error-copy test fell into and the reason both now read the source.
 */
test('the curve ABI declares every event the curve emits', () => {
  const src = source('Curve.sol');
  const events = declaredEvents(src);
  assert.ok(events.size >= 5, `only ${events.size} events found in Curve.sol`);

  const onAbi = eventShapes(CURVE_ABI as never);

  for (const [name, args] of events) {
    const declared = onAbi.get(name);
    assert.ok(
      declared !== undefined,
      `the curve emits \`${name}\` and the ABI does not declare it, so no log of it can be decoded`,
    );
    assert.deepEqual(
      declared,
      args,
      `\`${name}\` has a different shape on the ABI than in the contract, so its fields decode wrong`,
    );
  }

  for (const name of onAbi.keys()) {
    assert.ok(events.has(name), `the ABI declares event \`${name}\`, which the curve does not emit`);
  }
});

test('the factory ABI declares the event a creation is read back from', () => {
  /*
   * `createLaunchEvm` takes the new curve and token addresses out of `LaunchCreated`
   * rather than from `launchCount() - 1`, because two creations in one block would
   * make that read name somebody else's launch and send the person who just paid to
   * it. That only works if the event decodes.
   *
   * ONE DIRECTION HERE, UNLIKE THE CURVE. The curve's reader decodes every log the
   * contract emits, so every event it emits has to be declared. The factory's four
   * admin events (`LaunchFeeSet`, `PlatformSet`, the two admin transfers) are not read
   * by any screen, and demanding them would be requiring an ABI entry for a log
   * nothing looks at - the mirror of rule 40's "do not declare a variable nothing
   * reads". What is required is that `LaunchCreated` is there and that whatever IS
   * declared matches the contract.
   */
  const events = declaredEvents(source('Factory.sol'));
  assert.ok(
    events.has('LaunchCreated'),
    'Factory.sol no longer declares LaunchCreated, which createLaunchEvm reads the new addresses from',
  );

  const onAbi = eventShapes(FACTORY_ABI as never);
  assert.ok(onAbi.has('LaunchCreated'), 'the ABI does not declare LaunchCreated, so a creation cannot be read back');

  for (const [name, declared] of onAbi) {
    const actual = events.get(name);
    assert.ok(actual !== undefined, `the ABI declares event \`${name}\`, which the factory does not emit`);
    assert.deepEqual(declared, actual, `\`${name}\` decodes with the wrong shape`);
  }
});
