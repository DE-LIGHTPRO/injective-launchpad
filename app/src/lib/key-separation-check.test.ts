import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §2 of the runbook says the three roles must not be one key. Something has to check.
 *
 * THE DEFECT THIS EXISTS FOR. `verify-deployment.mjs` is step 9 of the mainnet runbook
 * and the only check that compares the live bundle against the chain. Run against the
 * live deployment on 16 Oct 2026 it reported every check green, printing
 *
 *     ✓ admin    inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl
 *     ✓ platform inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl
 *
 * one line apart and never comparing them. A report that lays the evidence in front of
 * a reader and leaves them to spot it is not a check: on launch morning, working
 * through a numbered list, nobody spots it. The two values being equal is correct on
 * testnet and a mainnet blocker, and the script had no way to tell the difference
 * because it had no notion of which chain it was talking to.
 *
 * WHY A SOURCE GUARD. The script talks to a live LCD and a live deployment, so there
 * is nothing to unit test. What can be pinned is the shape of the reasoning: that the
 * severity is decided by a measurement rather than by configuration, that the roles are
 * compared rather than printed, and that an account whose key shape is genuinely
 * unknown is not reported as safe or as unsafe.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const RUNBOOK = readFileSync(join(ROOT, 'docs', 'MAINNET-RUNBOOK.md'), 'utf8');

/**
 * Comment ranges blanked, so the prose explaining a rule cannot break it.
 *
 * The first draft of the test below asserted `NEXT_PUBLIC_NETWORK` is absent from the
 * script and failed on the comment that says severity must not be read from it. A
 * source guard that cannot tell code from the paragraph justifying the code either
 * fails on a correct file or, worse, passes on a wrong one because a comment mentioned
 * the right thing. Line numbers are preserved so a failure still points somewhere.
 */
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'verify-deployment.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

test('the roles are compared, not merely printed', () => {
  assert.match(
    SCRIPT,
    /cfg\.admin === cfg\.platform/,
    'the factory admin and the platform address are no longer compared, which is the exact defect this was added for',
  );
  assert.match(
    SCRIPT,
    /wasmAdmin === cfg\.admin \|\| wasmAdmin === cfg\.platform/,
    'the migration key is no longer compared against the other two roles',
  );
});

test('mainnet severity is measured from the chain, never read from configuration', () => {
  /*
   * NEXT_PUBLIC_NETWORK is an operator's stated intent, living in the same file this
   * script exists to verify. Deciding how loudly to complain by reading it would make
   * the check agree with whatever was configured. The LCD's own node_info says which
   * chain actually answered, which is the one fact that cannot be mis-set.
   */
  assert.match(
    SCRIPT,
    /default_node_info\?\.network/,
    'the chain id is no longer measured from the endpoint that answered',
  );
  assert.match(
    SCRIPT,
    /chainId === 'injective-1'/,
    'mainnet is no longer identified by the measured chain id',
  );
  assert.doesNotMatch(
    SCRIPT,
    /NEXT_PUBLIC_NETWORK/,
    'severity must not be decided by the configuration being verified',
  );
});

test('one key in three roles fails on mainnet and only reports elsewhere', () => {
  /*
   * Both halves matter. Failing on testnet, where one laptop key holding everything is
   * how it is supposed to look, would train whoever runs this to ignore the exit code,
   * and an exit code nobody reads protects nothing on the day it would have mattered.
   */
  assert.match(
    SCRIPT,
    /const note = mainnet \? bad : warn/,
    'the same finding must be a failure on injective-1 and a report anywhere else',
  );
  assert.match(SCRIPT, /^const warn = \(msg, detail\) => \{/m, 'the non-failing reporter is gone');
  assert.match(
    SCRIPT,
    /failures \+= 1/,
    'the failing reporter no longer counts, so nothing would change the exit code',
  );
  /*
   * `warn` must not quietly become a second `bad`. Anchored on the next declaration
   * rather than on the first occurrence of a common token: a source-reading slice
   * that ends at `indexOf('{')` or similar silently empties when something is added
   * above it, and an empty slice passes every doesNotMatch.
   */
  const warnStart = SCRIPT.indexOf('const warn =');
  const warnEnd = SCRIPT.indexOf('function loadEnv');
  assert.ok(warnStart > 0 && warnEnd > warnStart, 'the slice around warn is empty or inverted');
  assert.doesNotMatch(
    SCRIPT.slice(warnStart, warnEnd),
    /failures \+= 1/,
    'warn now counts as a failure, so a normal testnet deployment exits 1',
  );
});

test('an unproven key shape is reported as unknown, not as safe', () => {
  /*
   * A key shape is only on chain once the account has signed: an address that has
   * never signed publishes no public key, and one never seen on the chain at all
   * answers 404. Calling either "single-key" would be a guess, and calling either
   * "multisig" would be a dangerous one. Shapes confirmed against live endpoints on
   * 16 Oct 2026 - a module account returns pub_key: null, an account that has signed
   * returns /injective.crypto.v1beta1.ethsecp256k1.PubKey under base_account, and an
   * unseen address returns 404 code 5.
   */
  assert.match(SCRIPT, /return 'never signed'/, 'a never-signed account is no longer distinguished');
  assert.match(SCRIPT, /return 'absent'/, 'a 404 is no longer distinguished from a failed probe');
  assert.match(
    SCRIPT,
    /base_account\?\.pub_key/,
    "Injective wraps accounts in EthAccount; without this fallback every account reads as never having signed",
  );
  assert.match(
    SCRIPT,
    /includes\('multisig'\)/,
    'a native threshold account is identified by its pubkey type, not by failing to be a contract',
  );

  /*
   * A cw3 multisig IS a contract, and a contract address also answers the auth
   * endpoint with an ordinary single-key-looking account. Asking the wasm endpoint
   * second would call every contract-held admin a single key.
   */
  const contractProbe = SCRIPT.indexOf('/cosmwasm/wasm/v1/contract/${addr}');
  const accountProbe = SCRIPT.indexOf('/cosmos/auth/v1beta1/accounts/${addr}');
  assert.ok(contractProbe > 0 && accountProbe > 0, 'both holder probes must be present');
  assert.ok(
    contractProbe < accountProbe,
    'the contract probe must come first, or a cw3 multisig reads as a single key',
  );
});

test('the runbook still asks for the separation this enforces', () => {
  /*
   * The other half. A check enforcing a requirement the runbook has dropped is
   * enforcing nobody's decision, and this one is strict enough to block a launch.
   */
  assert.match(
    RUNBOOK,
    /Three roles, and they should not all be one key/,
    '§2 no longer states the requirement this check enforces',
  );
  assert.match(
    RUNBOOK,
    /The wasm admin should be a multisig/,
    '§2 no longer asks for a multisig on the migration key',
  );
  assert.match(
    RUNBOOK,
    /verify-deployment\.mjs/,
    'the runbook no longer names the script that checks this',
  );
});
