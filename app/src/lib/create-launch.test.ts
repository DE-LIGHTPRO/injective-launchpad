/**
 * The messages that create a launch.
 *
 * These have never been broadcast, so these tests are the only thing standing
 * between the form and a transaction that fails after the user has filled it in,
 * or worse, one that succeeds with a supply the curve cannot honour. They check
 * the construction against the contract's own expectations: the factory's
 * `CreateLaunch` arm, its exact-seed refusal, and the curve's validation.
 *
 * Two sibling defects are the reason this is a pure function with tests rather
 * than code inside a signing call: a v3 quote that produced calldata its router
 * could not answer, and a deposit address that needed a contract call rather than
 * a transfer. Both were built where no test could reach them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planLaunch,
  validateLaunch,
  seedAmount,
  denomFor,
  describePlan,
  LaunchInputError,
  MSG_CREATE_DENOM,
  MSG_MINT,
  MSG_SET_METADATA,
  TOKEN_DECIMALS,
  MSG_EXECUTE,
  type LaunchInput,
} from './createLaunch.ts';
import { CREATOR_FEE_SHARE_BPS, PLATFORM_FEE_SHARE_BPS } from './launchLimits.ts';
import type { CurveConfig } from './curve.ts';
import type { LaunchPlan } from './createLaunch.ts';

/*
 * Messages are found by type, never by index, and that is a lesson this suite
 * learned the hard way. Four tests here read `messages[2]` for the execute
 * message; adding `MsgSetDenomMetadata` ahead of it shifted every one of them and
 * they failed reading `undefined`. A positional anchor asserts the order as a side
 * effect of asserting something else, so inserting a message breaks tests that
 * have no opinion about ordering, while the one test that DOES assert the order
 * still does so explicitly above.
 */
const byType = (p: LaunchPlan, typeUrl: string): Record<string, unknown> => {
  const m = p.messages.find((x) => x.typeUrl === typeUrl);
  assert.ok(m, `no ${typeUrl} in the plan`);
  return m.value;
};


const ONE = 10n ** 18n;
const amt = (n: bigint) => n * ONE;
const CREATOR = 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49';
const FACTORY = 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqry8wy684';

const CURVE: CurveConfig = {
  virtualInj: amt(30n),
  virtualTokens: amt(1_073_000_000n),
  curveSupply: amt(800_000_000n),
  graduationTarget: amt(85n),
  feeBps: 100n,
};

const LP = amt(200_000_000n);

const input = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  creator: CREATOR,
  symbol: 'KAIJU',
  curve: CURVE,
  lpReserve: LP,
  factory: FACTORY,
  ...over,
});

test('four messages, in the order the chain requires', () => {
  // The denom must exist before it can be minted, and the supply must exist
  // before it can be attached. Any other order fails at the second message.
  const p = planLaunch(input());
  assert.deepEqual(
    p.messages.map((m) => m.typeUrl),
    [MSG_CREATE_DENOM, MSG_MINT, MSG_SET_METADATA, MSG_EXECUTE],
  );
});

test('the denom matches what the chain will derive', () => {
  /*
   * The chain builds `factory/<creator>/<subdenom>` itself. If this guessed a
   * different string the mint would target a denom that does not exist, and the
   * attach would reference one the factory has never seen.
   */
  const p = planLaunch(input());
  assert.equal(p.denom, `factory/${CREATOR}/KAIJU`);
  assert.equal(p.denom, denomFor(CREATOR, 'KAIJU'));
  const mint = p.messages[1].value as { amount: { denom: string } };
  const exec = byType(p, MSG_EXECUTE) as { funds: Array<{ denom: string }> };
  assert.equal(mint.amount.denom, p.denom, 'the mint targets a different denom');
  assert.equal(exec.funds[0].denom, p.denom, 'the attach references a different denom');
});

test('the attached amount is exactly what the factory demands', () => {
  /*
   * `instantiate` refuses anything but `curve_supply + lp_reserve`, over or
   * under, because the launch is funded once and nothing mints later. A curve
   * that accepted less would promise tokens it does not hold.
   */
  const p = planLaunch(input());
  const expected = CURVE.curveSupply + LP;
  assert.equal(p.seedAmount, expected);
  assert.equal(seedAmount(CURVE, LP), expected);

  const mint = p.messages[1].value as { amount: { amount: string } };
  const exec = byType(p, MSG_EXECUTE) as { funds: Array<{ amount: string }> };
  assert.equal(mint.amount.amount, expected.toString(), 'minted amount');
  assert.equal(exec.funds[0].amount, expected.toString(), 'attached amount');
  assert.equal(mint.amount.amount, exec.funds[0].amount, 'minting and attaching disagree');
});

test('amounts travel as decimal strings, never as numbers', () => {
  /*
   * 800,000,000 tokens at 18 decimals is 8e26. JSON has no integer that wide and
   * a Number is exact only to about 9e15, so serialising these as numbers loses
   * the amount silently and the chain receives a different figure than intended.
   */
  const p = planLaunch(input());
  const json = JSON.stringify(p.messages);
  assert.ok(json.includes('"1000000000000000000000000000"'), 'the seed is not a string in the payload');
  assert.ok(!/"amount":\s*\d/.test(json.replace(/"amount":\s*"/g, '')), 'an amount is a bare number');

  const exec = byType(p, MSG_EXECUTE) as { msg: { create_launch: { curve: Record<string, unknown> } } };
  const curve = exec.msg.create_launch.curve;
  for (const k of ['virtual_inj', 'virtual_tokens', 'curve_supply', 'graduation_target']) {
    assert.equal(typeof curve[k], 'string', `${k} must be a string`);
  }
  // fee_bps is a u16 on the contract and so is a number, deliberately.
  assert.equal(typeof curve.fee_bps, 'number');
  assert.equal(curve.fee_bps, 100);
});

test('the execute message names the keys the contract deserialises', () => {
  // snake_case, and the exact field names on `CreateLaunch`. A camelCase key
  // deserialises as a missing field and the contract refuses the whole message.
  const exec = byType(planLaunch(input()), MSG_EXECUTE) as unknown as {
    contract: string;
    sender: string;
    msg: { create_launch: Record<string, unknown> };
  };
  assert.equal(exec.contract, FACTORY);
  assert.equal(exec.sender, CREATOR);
  assert.deepEqual(
    Object.keys(exec.msg.create_launch).sort(),
    /*
     * `creator_fee_share_bps` is deliberately NOT here. It used to be a field a
     * creator set, capped at the whole fee, so the platform's share was something
     * every rational creator would set to zero. The factory now writes its own
     * constant, and this assertion is what fails if the field is ever reintroduced
     * as an input.
     */
    ['curve', 'denom', 'lp_reserve'],
  );
});

test('a ticker the chain would refuse is refused here instead', () => {
  /*
   * Tokenfactory subdenoms allow letters, digits, dot, dash and underscore. A
   * ticker with a space reaches MsgCreateDenom and fails there, after the user
   * has filled in the whole form and signed.
   */
  for (const bad of ['', 'A', 'has space', 'emoji🙂', '-leading', 'way'.repeat(20)]) {
    assert.throws(
      () => validateLaunch(input({ symbol: bad })),
      (e: unknown) => e instanceof LaunchInputError && e.field === 'symbol',
      `"${bad}" was accepted`,
    );
  }
  for (const ok of ['KA', 'KAIJU', 'kaiju_2', 'a.b-c']) {
    assert.doesNotThrow(() => validateLaunch(input({ symbol: ok })), `"${ok}" was refused`);
  }
});

test('a target the curve can never reach is refused, by the curve validator', () => {
  /*
   * Above `maxCollectable` the launch sells out, refuses further buys, and sits
   * there unable to graduate.
   *
   * I had written a second check for this in `validateLaunch` and a comment
   * saying the curve validator missed it. Both were wrong: `validate` tests the
   * identical condition and throws first, with a better sentence. This test now
   * asserts the behaviour that actually exists, which is what caught the dead
   * branch in the first place.
   */
  assert.throws(
    () => validateLaunch(input({ curve: { ...CURVE, graduationTarget: amt(10_000n) } })),
    (e: unknown) =>
      e instanceof LaunchInputError &&
      e.field === 'curve' &&
      /can never be reached/.test((e as Error).message),
  );
});

test('a zero liquidity reserve is refused even though the contract allows it', () => {
  /*
   * With no reserve a sold-out curve graduates holding quote and no token side,
   * so the migrated pool has nothing to pair. The contract tolerates it because
   * an operator might have a reason; a form should not produce it silently.
   */
  assert.throws(
    () => validateLaunch(input({ lpReserve: 0n })),
    (e: unknown) => e instanceof LaunchInputError && e.field === 'lpReserve',
  );
});

test('an unconnected wallet and a missing factory each say which is missing', () => {
  // Two different fixes. One sentence for both would send half the users to the
  // wrong one.
  assert.throws(
    () => validateLaunch(input({ creator: 'cosmos1whatever' })),
    (e: unknown) => e instanceof LaunchInputError && e.field === 'creator',
  );
  assert.throws(
    () => validateLaunch(input({ factory: '' })),
    (e: unknown) => e instanceof LaunchInputError && e.field === 'factory',
  );
});

test('the fee split is not something a launch can set', () => {
  /*
   * Replaces a test that checked the basis-point RANGE of a creator-set share. The
   * range was never the problem: 10_000 was inside it, and 10_000 means the platform
   * earns nothing on every trade of that launch. The field is gone, so what is worth
   * asserting is that the plan carries no way to express it.
   */
  const plan = planLaunch(input());
  const exec = byType(plan, MSG_EXECUTE) as { msg: { create_launch: Record<string, unknown> } };
  assert.ok(
    !('creator_fee_share_bps' in exec.msg.create_launch),
    'the launch message can still set the fee split',
  );
  assert.equal(CREATOR_FEE_SHARE_BPS + PLATFORM_FEE_SHARE_BPS, 10_000, 'the split does not total the fee');
  assert.equal(CREATOR_FEE_SHARE_BPS, 7_000, 'the creator share is not the measured 70%');
});

test('planning refuses rather than returning a plan that cannot execute', () => {
  // The plan is the thing that gets signed, so it must never exist in an invalid
  // state. Validation runs inside `planLaunch`, not only beside it.
  assert.throws(() => planLaunch(input({ symbol: 'no good' })), LaunchInputError);
});

test('the summary states the irreversible parts in the user\'s own terms', () => {
  /*
   * This is what someone reads before signing away an entire token supply, so it
   * has to name the three facts they cannot undo: the denom, that nothing can
   * mint more, and that all of it leaves their wallet.
   */
  const p = planLaunch(input());
  const lines = describePlan(p, CURVE, LP).join(' ');
  assert.match(lines, /factory\/inj1/, 'the denom is not named');
  assert.match(lines, /nothing can mint more/i, 'the fixed supply is not stated');
  assert.match(lines, /1,000,000,000/, 'the amount leaving the wallet is not stated');
  assert.match(lines, /800,000,000/, 'the curve share is not stated');
  assert.match(lines, /200,000,000/, 'the held-back share is not stated');
});

test('the metadata declares a display unit at 18, which is the part everyone gets wrong', () => {
  /*
   * Measured on Injective testnet before writing this: of the factory denoms that
   * set a name at all, the ones sampled carry `display: ""` and a single denom unit
   * at exponent 0. That tells every wallet the base unit is the display unit, so a
   * holder of a thousand tokens is shown 1000000000000000000000.
   *
   * The two units and a `display` naming the second one are what make a wallet
   * divide. This asserts the pair rather than the message merely being present,
   * because a metadata message with one unit is worse than none: it looks set.
   */
  const p = planLaunch(input());
  const meta = byType(p, MSG_SET_METADATA) as unknown as {
    metadata: {
      base: string;
      display: string;
      name: string;
      symbol: string;
      description: string;
      denom_units: Array<{ denom: string; exponent: number }>;
    };
  };
  const m = meta.metadata;

  assert.equal(m.base, p.denom, 'base must be the factory denom the chain moves');
  assert.equal(m.denom_units.length, 2, 'one unit means wallets show raw base units');

  const base = m.denom_units.find((u) => u.exponent === 0);
  const display = m.denom_units.find((u) => u.exponent === TOKEN_DECIMALS);
  assert.equal(base?.denom, p.denom);
  assert.equal(display?.denom, 'KAIJU');
  assert.equal(TOKEN_DECIMALS, 18);

  // `display` must name one of the units above or the wallet falls back to base.
  assert.ok(
    m.denom_units.some((u) => u.denom === m.display),
    `display ${m.display} names no declared unit`,
  );
  assert.notEqual(m.display, m.base, 'displaying the base unit is the defect itself');
});

test('an empty name falls back to the ticker, never to an empty string', () => {
  // A blank `name` is what the sampled denoms carry, and an explorer with nothing
  // to print falls back to the raw denom. The ticker is always available.
  const m = (byType(planLaunch(input()), MSG_SET_METADATA) as unknown as { metadata: { name: string; description: string } }).metadata;
  assert.equal(m.name, 'KAIJU');
  assert.equal(m.description, '', 'an absent description is empty, not invented');

  const named = (
    byType(
      planLaunch({ ...input(), name: '  Kaiju Token  ', description: '  A test.  ' }),
      MSG_SET_METADATA,
    ) as unknown as { metadata: { name: string; description: string } }
  ).metadata;
  assert.equal(named.name, 'Kaiju Token', 'surrounding whitespace survived into the chain');
  assert.equal(named.description, 'A test.');
});

test('the metadata sender is the creator, who is the only denom admin', () => {
  // MsgSetDenomMetadata is admin-only. Any other sender fails the whole
  // transaction, taking the denom and the mint with it.
  const i = input();
  const m = byType(planLaunch(i), MSG_SET_METADATA) as unknown as { sender: string };
  assert.equal(m.sender, i.creator);
});
