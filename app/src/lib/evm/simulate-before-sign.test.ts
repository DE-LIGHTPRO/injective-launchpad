/**
 * Nothing is signed on the EVM backend without being simulated first.
 *
 * THE RAIL PROMISED THIS BEFORE IT WAS TRUE, which is how it was found: pressing Buy
 * on the running EVM build drew `TxDialog`'s five steps, the second of which reads
 * "Checking - running it against the chain first, so a failure costs you nothing".
 * There was no such call. `executeEvm` went from the account check straight to
 * `writeContract`, so a buy the curve would refuse - slippage, a wallet cap, trading
 * not open yet - was signed, broadcast and reverted, and the user paid gas to learn
 * what an `eth_call` would have said for free. The CosmWasm path has simulated since
 * audit F-09.
 *
 * WHY THIS IS A SOURCE READ. The property is "every write goes through the one helper
 * that simulates", and that is a statement about the shape of the file rather than
 * about the result of a call. A unit test would need an EIP-1193 provider and a chain;
 * and worse, it could only check the branches it thought to exercise, which is the
 * "guard scoped to one branch" failure this file exists to prevent. There are four
 * writes here - buy, sell, the sell's approval and createLaunch - and a fifth added
 * later must be covered by default rather than by someone remembering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WRITE_TS = join(import.meta.dirname, 'write.ts');

/**
 * The source with comment ranges blanked.
 *
 * Masked by regex and failing safe, for the reason the em-dash sweep recorded: a
 * line-based filter rewrites a block comment's interior lines, and a character scanner
 * breaks on an apostrophe in prose. The comments here discuss `writeContract` and
 * `simulateContract` by name, so measuring them would make this guard pass on a file
 * that only talks about simulating.
 */
function code(): string {
  const raw = readFileSync(WRITE_TS, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

test('writeContract is called in exactly one place', () => {
  const src = code();
  const calls = [...src.matchAll(/\bwriteContract\s*\(/g)];
  /*
   * ONE call site, so the simulation cannot be true of three branches and false of the
   * fourth. The three trade branches and createLaunch were four copies of
   * sign-then-wait before this; adding the pre-flight to three of them would have left
   * the fourth signing blind with nothing on the screen saying so.
   */
  assert.equal(
    calls.length,
    1,
    `writeContract is called ${calls.length} times; every EVM write must go through signAndSettle`,
  );
});

test('the one call site simulates first, and sends what it simulated', () => {
  const src = code();
  const helper = src.slice(src.indexOf('async function signAndSettle'));
  const body = helper.slice(0, helper.indexOf('\n}\n') + 1);
  assert.ok(body.includes('writeContract'), 'signAndSettle is not the function that writes');

  const sim = body.indexOf('simulateContract');
  const write = body.indexOf('writeContract');
  assert.ok(sim >= 0, 'signAndSettle does not simulate at all');
  assert.ok(sim < write, 'signAndSettle writes before it simulates');

  /*
   * THE SIMULATED CALL IS THE CALL THAT IS SENT. viem returns a `request` from
   * `simulateContract` and that object goes to `writeContract`. Rebuilding the
   * arguments for the write would let the thing checked and the thing signed differ -
   * the defect recorded for a v3 quote that built v2 calldata, and for a plan that was
   * shown while another message was sent.
   */
  assert.match(body, /const \{ request \} = await .*simulateContract/s);
  assert.match(body, /writeContract\(request/);
});

test('the simulating stage is reported, so the rail is not drawing a step that does not happen', () => {
  const src = code();
  assert.match(src, /onStage\?\.\('simulating'\)/);
  /*
   * MEASURED INSIDE THE HELPER'S BODY, not across the file. The first version used
   * `indexOf` over the whole source and failed: `signAndSettle`'s own signature names
   * `simulateContract` in a type position (`Parameters<PublicClient['simulateContract']>`)
   * which sits ABOVE the stage report, so the assertion was comparing a type reference
   * with a call. Anchoring a source read to the first occurrence of a common token is
   * the mistake `cctp-speed-toggle` recorded; anchor it to what it measures.
   */
  const helper = src.slice(src.indexOf('  onStage?.(\'simulating\');'));
  const body = helper.slice(0, helper.indexOf('\n}\n') + 1);
  const stage = body.indexOf("onStage?.('simulating')");
  const sim = body.indexOf('await evmClient().simulateContract');
  assert.ok(sim >= 0, 'the helper does not call simulateContract on the public client');
  assert.ok(stage >= 0 && stage < sim, 'the stage is reported after the call it describes');
});

test('every message branch reaches signAndSettle', () => {
  const src = code();
  /*
   * Derived from the branches rather than listed: a fifth message added to `executeEvm`
   * is covered the moment it is written, instead of when somebody remembers this file.
   */
  const branches = [...src.matchAll(/if \('(\w+)' in opts\.msg\)/g)].map((m) => m[1]);
  assert.ok(branches.length >= 3, `only ${branches.length} message branches found`);
  assert.deepEqual(branches, ['buy', 'sell', 'claim_fees']);

  const exec = src.slice(src.indexOf('export async function executeEvm'));
  const execBody = exec.slice(0, exec.indexOf('\n}\n') + 1);
  const sends = [...execBody.matchAll(/signAndSettle\(/g)];
  // Four: buy, the sell's approval, the sell, and claim.
  assert.equal(sends.length, 4, `executeEvm has ${sends.length} signAndSettle calls, expected 4`);
  assert.ok(!execBody.includes('writeContract'), 'executeEvm writes directly, bypassing the helper');
});

test('createLaunch goes through it too', () => {
  const src = code();
  const create = src.slice(src.indexOf('export async function createLaunchEvm'));
  assert.ok(create.includes('signAndSettle('), 'createLaunchEvm does not simulate before signing');
  assert.ok(!create.includes('writeContract'), 'createLaunchEvm writes directly');
});
