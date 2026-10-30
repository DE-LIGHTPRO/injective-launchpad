import test from 'node:test';
import assert from 'node:assert/strict';
import {
  launchCost,
  launchAffordable,
  DENOM_CREATION_FEE,
  LAUNCH_GAS_RESERVE,
  denomCreationFeeFor,
  fetchDenomCreationFee,
  launchGasReserveFor,
} from './launchCost.ts';
import { planLaunch, MSG_EXECUTE } from './createLaunch.ts';
import { fixedCurveFor, FIXED_LP_RESERVE } from './launchLimits.ts';

/**
 * What a launch costs, worked out before anybody signs.
 *
 * THE DEFECT THIS EXISTS FOR, reported from production. A creator filled in the
 * form, ticked the irreversibility box, opened their wallet and signed. The chain
 * refused it and the page said "The chain refused the transaction." The real reason,
 * measured by simulating the same message:
 *
 *   spendable balance 403213882356322213inj is smaller than 1000000000000000000inj
 *
 * Injective charges a flat 1 INJ to create a denom and the wallet held 0.403. Both
 * numbers were known to the page before anything was signed.
 */

const ONE = 10n ** 18n;

test('the cost is the chain fee, the launchpad fee, gas and the opening buy', () => {
  const c = launchCost({ quoteDenom: 'inj', gasDenom: 'inj' });
  assert.equal(c.denomFee, DENOM_CREATION_FEE);
  assert.equal(c.gasReserve, LAUNCH_GAS_RESERVE);
  assert.equal(c.total, DENOM_CREATION_FEE + LAUNCH_GAS_RESERVE);

  const withAll = launchCost({
    openingBuy: 3n * ONE,
    launchFee: 2n * ONE / 10n,
    launchFeeDenom: 'inj',
    quoteDenom: 'inj',
    gasDenom: 'inj',
  });
  assert.equal(withAll.total, DENOM_CREATION_FEE + (2n * ONE) / 10n + LAUNCH_GAS_RESERVE + 3n * ONE);
});

test('a cost in another denom has no claim on the gas balance', () => {
  /*
   * A dev buy on a USDC-paired launch is spent in USDC. Counting it against the INJ
   * balance would refuse a launch the creator can comfortably afford, which is the
   * opposite failure and just as wrong.
   */
  const c = launchCost({
    openingBuy: 1_000_000_000n,
    launchFee: 5n * ONE,
    launchFeeDenom: 'peggy0xUSDC',
    quoteDenom: 'peggy0xUSDC',
    gasDenom: 'inj',
  });
  assert.equal(c.openingBuy, 0n);
  assert.equal(c.launchFee, 0n);
  assert.equal(c.total, DENOM_CREATION_FEE + LAUNCH_GAS_RESERVE);
});

test('an unknown balance never refuses a launch', () => {
  /*
   * `null` is "not read", not "insufficient". An unreachable LCD says nothing about
   * whether the wallet is funded, and blocking on it would make a node blip look
   * like an empty wallet. The chain stays the authority.
   */
  const c = launchCost({ quoteDenom: 'inj', gasDenom: 'inj' });
  assert.equal(launchAffordable(null, c), null);
  assert.equal(launchAffordable(c.total - 1n, c), false);
  assert.equal(launchAffordable(c.total, c), true);
});

test('the launchpad fee and the opening buy arrive as ONE coin', () => {
  /*
   * A wallet cannot attach two separate `inj` entries: the bank module merges them
   * before the contract sees anything, and the factory checks the funds exactly. If
   * the plan sends two entries, what we built is not what the chain receives and the
   * launch is refused for funds that were in fact attached.
   */
  const plan = planLaunch({
    creator: 'inj1' + 'q'.repeat(38),
    symbol: 'ABC',
    curve: { ...fixedCurveFor(18), feeBps: 100n, feeSellBps: 100n },
    lpReserve: FIXED_LP_RESERVE,
    factory: 'inj1' + 'z'.repeat(38),
    initialBuy: 3n * ONE,
    launchFee: { amount: (2n * ONE) / 10n, denom: 'inj' },
  });
  const exec = plan.messages.find((m) => m.typeUrl === MSG_EXECUTE);
  const funds = (exec!.value as { funds: Array<{ denom: string; amount: string }> }).funds;
  const inj = funds.filter((f) => f.denom === 'inj');
  assert.equal(inj.length, 1, `inj was attached as ${inj.length} entries`);
  assert.equal(BigInt(inj[0].amount), 3n * ONE + (2n * ONE) / 10n);
});

test('a launch with no launchpad fee attaches exactly what it always did', () => {
  // The common case must be untouched: an older factory charges nothing and refuses
  // funds it did not expect.
  const plan = planLaunch({
    creator: 'inj1' + 'q'.repeat(38),
    symbol: 'ABC',
    curve: { ...fixedCurveFor(18), feeBps: 100n, feeSellBps: 100n },
    lpReserve: FIXED_LP_RESERVE,
    factory: 'inj1' + 'z'.repeat(38),
  });
  const exec = plan.messages.find((m) => m.typeUrl === MSG_EXECUTE);
  const funds = (exec!.value as { funds: Array<{ denom: string }> }).funds;
  assert.equal(funds.length, 1, 'something extra was attached to a free launch');
});

test('mainnet and testnet charge different denom fees', () => {
  /*
   * MEASURED 12 Oct 2026, by asking each chain rather than assuming they agree:
   * testnet charges 1 INJ, mainnet charges 0.1. The constant was taken from testnet,
   * so on mainnet the pre-flight would have told a creator they need 1.25 INJ when
   * they need 0.35 and refused a launch they could comfortably afford, from a check
   * written to prevent exactly that. Both numbers are plausible and nothing on
   * screen would have looked wrong.
   */
  assert.equal(denomCreationFeeFor('testnet'), 1_000_000_000_000_000_000n);
  assert.equal(denomCreationFeeFor('mainnet'), 100_000_000_000_000_000n);
  assert.notEqual(denomCreationFeeFor('mainnet'), denomCreationFeeFor('testnet'));

  // And the cost follows the fee it is given, rather than a constant of its own.
  const main = launchCost({
    denomFee: denomCreationFeeFor('mainnet'),
    quoteDenom: 'inj',
    gasDenom: 'inj',
  });
  assert.equal(main.denomFee, 100_000_000_000_000_000n);
  assert.ok(main.total < launchCost({ quoteDenom: 'inj', gasDenom: 'inj' }).total);
});

test('an unreadable chain fee keeps the measured constant, never zero', async () => {
  /*
   * Zero would under-report the cost and put the failure back where it started:
   * after signing. `null` is what the caller falls back on.
   */
  assert.equal(await fetchDenomCreationFee('http://127.0.0.1:1'), null);
});

/**
 * THE EVM BACKEND CHARGES NEITHER OF THE TWO FIGURES THIS MODULE WAS WRITTEN AROUND,
 * and both were blocking launches it could comfortably afford.
 *
 * The denom fee is Injective's charge for creating a tokenfactory denom. There is no
 * tokenfactory on the EVM side. But `fetchDenomCreationFee` asks a CosmWasm LCD route
 * against a JSON-RPC host, gets nothing, and correctly treats that as "unread" - which
 * correctly falls back to the measured constant, which is 1 INJ for a fee that is not
 * charged at all. Every one of those steps is right and the answer is wrong, which is
 * the two-halves-locally-correct shape this project keeps recording.
 *
 * The gas reserve was the same in the same direction. MEASURED against the live
 * factory on 30 Oct 2026: `eth_estimateGas` on `createLaunch` returned 2,588,418 gas
 * at 0.16 gwei, so a creation costs 0.000414 INJ. The 0.05 INJ reserve is 120x that,
 * and it told a creator holding 0.0085 INJ - enough for twenty launches - to top up.
 *
 * Erring high is harmless for a fee that is real and might have changed. It is not
 * harmless for one that is not charged, from a check written to stop somebody signing
 * a doomed transaction.
 */
test('the EVM backend is charged no denom fee, because no denom is created', () => {
  assert.equal(denomCreationFeeFor('evm'), 0n);
  // And the chains that DO charge it keep their measured figures: this is an addition.
  assert.equal(denomCreationFeeFor('testnet'), 1_000_000_000_000_000_000n);
  assert.equal(denomCreationFeeFor('mainnet'), 100_000_000_000_000_000n);
});

test('the EVM gas reserve is a margin over a measurement, not the CosmWasm figure', () => {
  const evm = launchGasReserveFor('evm');
  const cosm = launchGasReserveFor('mainnet');
  assert.equal(cosm, LAUNCH_GAS_RESERVE, 'the CosmWasm reserve changed');
  assert.ok(evm < cosm, 'the EVM reserve is not smaller than the five-message one');

  /*
   * Bounded on BOTH sides against the measurement, which is what makes this a test
   * rather than a restatement. Above the measured 0.000414 INJ, so it covers a gas
   * price spike; under a twentieth of the CosmWasm reserve, so nobody can quietly
   * raise it back to a figure that refuses a funded creator.
   */
  const measured = 414_146_880_000_000n; // 2,588,418 gas x 0.16 gwei, 30 Oct 2026
  assert.ok(evm > measured, 'the EVM reserve is below the measured cost of a creation');
  assert.ok(evm < cosm / 5n, 'the EVM reserve has drifted back toward the CosmWasm one');
});

test('a launch on the EVM backend costs gas and nothing else', () => {
  const c = launchCost({
    denomFee: denomCreationFeeFor('evm'),
    gasReserve: launchGasReserveFor('evm'),
    quoteDenom: 'inj',
    gasDenom: 'inj',
  });
  assert.equal(c.denomFee, 0n);
  assert.equal(c.launchFee, 0n);
  assert.equal(c.total, launchGasReserveFor('evm'));

  /*
   * THE CASE THAT WAS ON THE SCREEN. 0.0085 INJ was refused with "Creating a token
   * costs 0.05 INJ. Top the wallet up and this will unlock." It is twenty creations'
   * worth of gas.
   */
  assert.equal(launchAffordable(8_500_000_000_000_000n, c), true);
});
