/**
 * The app reads and signs on the same chain, and asks rather than assuming.
 *
 * THE OTHER HALF OF `keeper-chain-match.test.ts`. That one guards
 * `scripts/payout-keeper.mjs`, which has asked the endpoint which chain it is since it
 * was written. The deployed app never did, and it is the half a person looks at: the
 * runbook sets `NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_LCD_URL` as separate steps for
 * Vercel exactly as it does for the repository variables, so the same omission lands
 * here, and here it is silent.
 *
 * `NEXT_PUBLIC_NETWORK` picks the chain id every signature commits to, the denom
 * creation fee, the explorer and the default endpoint. `NEXT_PUBLIC_LCD_URL` overrides
 * the endpoint alone, and that endpoint serves the board, the balances, the account
 * sequence a transaction is signed against and the broadcast itself. Each is locally
 * correct. Together they can name two different chains, and nothing errors where the
 * error is: the board fills with the other chain's launches and reads as the market,
 * the two chains' denom fees differ by 10x, and the first thing that fails is the
 * broadcast, after the user has signed.
 *
 * Testnet reading testnet is self-consistent, so the day this matters is the day
 * somebody flips one variable to mainnet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assessChainMatch } from './chainMatch.ts';
import { NETWORK } from './config.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');

test('an answer that disagrees with the chain we sign for is a mismatch', () => {
  const other = NETWORK.chainId === 'injective-1' ? 'injective-888' : 'injective-1';
  assert.deepEqual(assessChainMatch(other), {
    verdict: 'mismatch',
    served: other,
    expected: NETWORK.chainId,
  });
});

test('the expected id is the one the wallet is asked to sign for, not a literal', () => {
  /*
   * Anti-vacuity with teeth. A guard that compared against a hardcoded 'injective-888'
   * would pass on testnet forever and say nothing about the configuration it exists to
   * check. The match case has to follow NETWORK, so flipping the network flips it.
   */
  assert.deepEqual(assessChainMatch(NETWORK.chainId), {
    verdict: 'match',
    served: NETWORK.chainId,
  });
  assert.ok(NETWORK.chainId.startsWith('injective-'), 'the chain id is not the shape this compares');
});

test('no answer is no opinion, never a mismatch', () => {
  /*
   * An endpoint that did not answer is already reported by the read that failed, with
   * better words. Turning silence into a verdict would put a red configuration banner
   * on the page for a dropped connection, which is the readiness check's own rule:
   * unmeasured is not the same as wrong.
   */
  for (const empty of [null, undefined, '', '   ']) {
    assert.deepEqual(assessChainMatch(empty), { verdict: 'unknown' }, `${JSON.stringify(empty)} became a verdict`);
  }
});

test('surrounding whitespace is not a different chain', () => {
  assert.equal(assessChainMatch(`  ${NETWORK.chainId}\n`).verdict, 'match');
});

test('the probe treats a 200 as a shape to check, not as an answer', () => {
  /*
   * This origin serves the app as well, so a misrouted request can land on an HTML page
   * with a 200. The repeated lesson here is that a status is not a payload.
   */
  const src = readFileSync(join(SRC, 'lib', 'chainMatch.ts'), 'utf8');
  assert.match(src, /if \(!res\.ok\) return null/, 'a non-200 is being parsed as a chain id');
  assert.match(src, /typeof network === 'string'/, 'the body shape is not checked before it is trusted');
  assert.match(src, /catch \{\s*return null;/, 'a thrown fetch becomes something other than "no opinion"');
  /*
   * Masked, because the docblock above the code names both variables in order to
   * explain why neither may be read here. Unmasked this fails on a correct file, which
   * is the exact mistake `key-separation-check` made and `maskComments` exists for.
   */
  assert.doesNotMatch(
    maskComments(src),
    /NEXT_PUBLIC_NETWORK/,
    'the probe reads the variable it is checking, so it would agree with itself',
  );
});

test('the banner is reachable, and on every page rather than per page', () => {
  /*
   * Registration is not wiring, and this codebase's most repeated defect is a module
   * with its own passing suite and no call site. A banner nothing mounts is worse than
   * none: the suite below would stay green while the condition it describes went
   * unannounced on a production deployment.
   *
   * The layout is the specific requirement, not merely "somewhere". Mounted per page it
   * would be correct on the pages that remembered and absent on the next one added, and
   * the condition is global.
   */
  const layout = readFileSync(join(SRC, 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /<ChainMismatchBanner \/>/, 'the root layout does not render the banner');
  assert.match(layout, /from '@\/components\/ChainMismatchBanner'/, 'the layout does not import it');

  const banner = readFileSync(join(SRC, 'components', 'ChainMismatchBanner.tsx'), 'utf8');
  assert.match(banner, /probeServedChainId/, 'the banner never asks the endpoint anything');
  assert.match(banner, /assessChainMatch/, 'the banner compares for itself rather than using one resolver');
  assert.match(
    banner,
    /verdict !== 'mismatch'\) return null/,
    'the banner renders on something other than a measured disagreement',
  );
  assert.match(banner, /role="alert"/, 'the banner is not announced');
});

test('nothing else compares chain ids for itself', () => {
  /*
   * One resolver. Two places deciding what counts as a mismatch is how the two halves
   * of this very defect came to disagree in the first place.
   */
  const files = (function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  })(SRC);

  const offenders = files
    .filter((f) => !f.endsWith('chainMatch.ts'))
    .filter((f) => /default_node_info/.test(readFileSync(f, 'utf8')))
    .map((f) => f.split('/src/').pop()!);

  assert.deepEqual(offenders, [], `${offenders.join(', ')} reads the served chain id directly; use probeServedChainId`);

  // The sweep has to be able to find the one legitimate reader, or it proves nothing.
  const canonical = readFileSync(join(SRC, 'lib', 'chainMatch.ts'), 'utf8');
  assert.match(canonical, /default_node_info/, 'the canonical probe no longer asks; this sweep is now vacuous');
});

test('the mainnet runbook says the two must agree', () => {
  /*
   * The code can only catch this once a deployment is live and someone loads a page.
   * The runbook is where it is cheap to catch, and it already calls NEXT_PUBLIC_NETWORK
   * the one that bites - this pins that it keeps saying so alongside the endpoint.
   */
  const runbook = readFileSync(join(SRC, '..', '..', 'docs', 'MAINNET-RUNBOOK.md'), 'utf8');
  for (const v of ['NEXT_PUBLIC_NETWORK', 'NEXT_PUBLIC_LCD_URL']) {
    assert.match(runbook, new RegExp(v), `${v} is no longer in the runbook`);
  }
  assert.match(
    runbook,
    /must name the same chain/,
    'the runbook no longer states that the network and the endpoint have to agree',
  );
});
