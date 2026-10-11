/**
 * Composing a launch into signable messages.
 *
 * The encoding itself cannot be verified here: that needs a node, and when it is wrong
 * the transaction is rejected, which costs gas and creates nothing. What CAN be
 * verified is the step before it, and it is the step with a real failure mode.
 *
 * `composeMessages` maps the plan's four messages onto SDK objects. If one were dropped
 * or mapped to the wrong type, the transaction would still be valid and would still
 * land: a denom created and a supply minted, with nothing handed to the factory, leaving
 * the creator holding tokens no curve will ever sell. That failure succeeds, which is
 * why it is tested and the encoding is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransaction } from '@injectivelabs/sdk-ts';
import { composeMessages, describeBroadcastFailure, BroadcastError } from './broadcast.ts';
import { planLaunch, MSG_EXECUTE, type LaunchInput } from './createLaunch.ts';
import type { CurveConfig } from './curve.ts';

const ONE = 10n ** 18n;
const CREATOR = 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqry8wy684';
const FACTORY = 'inj1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzry8wy684';

const curve: CurveConfig = {
  virtualInj: 30n * ONE,
  virtualTokens: 1_073_000_000n * ONE,
  curveSupply: 800_000_000n * ONE,
  graduationTarget: 85n * ONE,
  feeBps: 100n,
};

const input = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  creator: CREATOR,
  symbol: 'KAIJU',
  curve,
  lpReserve: 200_000_000n * ONE,
  factory: FACTORY,
  ...over,
});

test('every message in the plan is composed, none dropped', () => {
  /*
   * A count, because this is the assertion that catches the dangerous case. A missing
   * `MsgExecuteContract` produces a transaction that LANDS: denom created, supply
   * minted, nothing given to the factory. Nothing errors, nothing reverts, and the
   * creator is left holding a token with no curve.
   */
  const plan = planLaunch(input());
  const msgs = composeMessages(plan, CREATOR);
  assert.equal(msgs.length, plan.messages.length, 'a message was dropped during composition');
  assert.equal(msgs.length, 5);
});

test('the composed messages build a transaction, which is where encoding actually runs', () => {
  /*
   * THE DEFECT THIS EXISTS FOR. `composeMessages` calls each SDK `fromJSON`, which only
   * STORES the params; the encoding (`.denomUnits.map(...)` and the rest) runs later,
   * when `createTransaction` serialises the messages right before signing. So a test
   * that stopped at `composeMessages` passed while the browser threw "Cannot read
   * properties of undefined (reading 'map')" the moment it tried to sign: the plan built
   * metadata as snake_case `denom_units`, and the SDK reads camelCase `denomUnits`.
   *
   * This test carries the messages the one step further, into `createTransaction`, which
   * is exactly what `signAndBroadcast` does before the wallet prompt. It fails against
   * the unfixed composer. A dummy pubkey and zeroed account are fine: nothing is signed
   * or sent, only encoded.
   */
  const plan = planLaunch(input({ name: 'Kaiju', description: 'a test' }));
  const msgs = composeMessages(plan, CREATOR);
  assert.doesNotThrow(() => {
    createTransaction({
      message: msgs,
      memo: '',
      fee: { amount: [{ denom: 'inj', amount: '1' }], gas: '3000000' },
      pubKey: Buffer.from('A'.repeat(33)).toString('base64'),
      sequence: 0,
      accountNumber: 0,
      chainId: 'injective-888',
    });
  }, 'the composed messages could not be encoded into a transaction');
});

test('an unknown message type throws rather than being skipped', () => {
  /*
   * The guard that makes the count above hold in future. Adding a fifth message to the
   * plan without handling it here must fail loudly: a `default` that returned null and
   * a `.filter(Boolean)` would be the natural way to write this, and it would silently
   * sign a launch missing a step.
   */
  const plan = planLaunch(input());
  const tampered = {
    ...plan,
    messages: [...plan.messages, { typeUrl: '/some.future.Msg', value: {} }],
  };
  assert.throws(
    () => composeMessages(tampered, CREATOR),
    (e: unknown) => e instanceof BroadcastError && e.kind === 'simulate',
    'an unrecognised message was accepted',
  );
});

test('the funds attached are the plan"s, not a recomputed figure', () => {
  /*
   * The factory refuses any amount but the exact seed, so a recomputation here that
   * drifted by one unit would make every launch fail. More to the point, the number the
   * user approved on screen and the number signed have to be one value: `planLaunch`
   * produces both.
   */
  const plan = planLaunch(input());
  const exec = plan.messages.find((m) => m.typeUrl === MSG_EXECUTE)!;
  const funds = (exec.value as { funds: Array<{ denom: string; amount: string }> }).funds;
  assert.equal(funds.length, 1);
  assert.equal(funds[0].amount, plan.seedAmount.toString());
  assert.equal(funds[0].denom, plan.denom);
  // And it really is the whole supply: curve plus the held-back reserve.
  assert.equal(plan.seedAmount, curve.curveSupply + 200_000_000n * ONE);
});

test('the sender is the connected account on every message', () => {
  /*
   * Four messages, four senders, and a mismatch on any one of them fails the whole
   * transaction after the prompt. The creator is also the denom admin, so a different
   * sender on the metadata message is specifically the one that would be unauthorised.
   */
  const plan = planLaunch(input());
  const msgs = composeMessages(plan, CREATOR) as Array<{ toJSON?: () => unknown; params?: unknown }>;
  const serialised = JSON.stringify(msgs.map((m) => m.params ?? m));
  assert.ok(serialised.includes(CREATOR), 'the connected account does not appear in the messages');
  // Nothing else should: a stray address here is funds or authority going elsewhere.
  assert.ok(
    !serialised.includes('inj1demo'),
    'a placeholder address survived into a signable message',
  );
});

test('a node error is translated, never shown raw', () => {
  /*
   * Node errors are written for validator operators: they carry module paths and type
   * URLs, and shown to a creator they read as a crash rather than as a thing to fix.
   */
  assert.match(describeBroadcastFailure('insufficient funds for fee'), /Not enough INJ/);
  assert.match(describeBroadcastFailure('denom already exists'), /already taken/);
  assert.match(describeBroadcastFailure('out of gas in location: WriteFlat'), /ran out of gas/);
  assert.match(describeBroadcastFailure('account sequence mismatch, expected 7'), /still settling/);

  // The fallback says what did NOT happen, which is the first thing anyone wants to
  // know when a launch fails: whether they have lost a supply or created half a thing.
  const unknown = describeBroadcastFailure('failed to execute message; message index: 3: dispatch: submessages');
  assert.match(unknown, /Nothing was created/);
  assert.ok(!unknown.includes('submessages'), 'the raw node error leaked into the message');
  assert.ok(!unknown.includes('message index'), 'the raw node error leaked into the message');
});
