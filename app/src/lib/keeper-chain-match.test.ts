/**
 * The payout keeper reads and signs on the same chain, and proves it rather than
 * assuming it.
 *
 * `NEXT_PUBLIC_NETWORK` chooses the LCD *and* the chain the broadcaster signs for, and
 * it defaults to testnet. That default is right for a laptop and wrong in the payout
 * workflow, where the runbook's step 10 sets three repository variables with three
 * separate commands: miss the network one and a mainnet factory is read over a mainnet
 * LCD while the transaction is signed for injective-888. Nothing is mispaid, because a
 * testnet signature cannot reach a mainnet contract. Nothing is paid either, every
 * fifteen minutes, unattended, and the message blames the factory.
 *
 * Two halves, because neither covers the other:
 *   - the keeper asks the LCD which chain it is and refuses a disagreement, which is
 *     the only check that can tell a mainnet endpoint from a testnet one;
 *   - the workflow requires the variable, which catches both being absent together -
 *     a state no probe can detect, since testnet reading testnet is self-consistent.
 *
 * A source guard because the failure needs two chains and a schedule to reproduce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const KEEPER = readFileSync(join(ROOT, 'scripts', 'payout-keeper.mjs'), 'utf8');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'payout.yml'), 'utf8');

test('the keeper compares the chain the LCD serves with the chain it signs for', () => {
  assert.match(
    KEEPER,
    /default_node_info\?\.network/,
    'nothing asks the endpoint which chain it is, so a mainnet LCD is indistinguishable from a testnet one',
  );
  assert.match(
    KEEPER,
    /getNetworkChainInfo\(network\)\.chainId/,
    'the expected chain id is not derived from the network the broadcaster uses, so the two can drift',
  );
  assert.match(
    KEEPER,
    /served && served !== expectedChainId/,
    'the served chain id is not compared, or is compared without allowing for an unanswered probe',
  );
});

test('the comparison happens before anything is read or signed', () => {
  const probe = KEEPER.indexOf('default_node_info');
  const read = KEEPER.indexOf('{ launches: { limit:');
  const broadcast = KEEPER.indexOf('MsgBroadcasterWithPk({');
  assert.ok(probe > 0 && read > 0 && broadcast > 0, 'this guard is looking for code that has moved');
  assert.ok(probe < read, 'the chain is checked after the factory is read, so the read still reports the wrong reason');
  assert.ok(probe < broadcast, 'the chain is checked after the broadcaster is built');
});

test('an unreachable endpoint yields no opinion rather than a refusal', () => {
  /*
   * Rule of this codebase and of the readiness check: a probe that cannot be answered
   * must not become a verdict. The read below reports an unreachable endpoint with a
   * better message, so a failing probe here would replace a clear error with a
   * confusing one.
   */
  const i = KEEPER.indexOf('default_node_info');
  const around = KEEPER.slice(Math.max(0, i - 400), i + 200);
  assert.match(around, /r\.ok \? r\.json\(\) : null/, 'a non-200 is being parsed as a chain id');
  assert.match(around, /\.catch\(\(\) => null\)/, 'a network failure is not being turned into "no opinion"');
});

test('the payout workflow requires the network to be chosen, not defaulted', () => {
  assert.match(
    WORKFLOW,
    /if \[ -z "\$NEXT_PUBLIC_NETWORK" \]; then/,
    'the workflow runs with NEXT_PUBLIC_NETWORK unset, which silently means testnet',
  );
  /*
   * And it must still require the other two, since this guard is the only place all
   * three are asserted together.
   */
  for (const v of ['INJ_MNEMONIC', 'NEXT_PUBLIC_FACTORY_ADDRESS']) {
    assert.match(WORKFLOW, new RegExp(`if \\[ -z "\\$${v}" \\]; then`), `${v} is no longer checked`);
  }
});
