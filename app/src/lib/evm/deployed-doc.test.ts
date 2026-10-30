/**
 * The deployment document does not drift from the code it describes.
 *
 * WHY THIS EXISTS. `evm/DEPLOYED.md` named `0xD31966ef…` as the live factory for two
 * days after it stopped being one. Defects found while wiring the EVM port up each
 * meant a new factory - these contracts are immutable by design - and the file that
 * tells the next person which address is live was not part of that loop.
 *
 * A stale address there is worse than a dead link: `0xD31966ef…` still holds 16,773
 * bytes of code and still answers every call, so following the document gets you a
 * working launchpad running an older contract. Nothing errors.
 *
 * WHAT A TEST CAN AND CANNOT CHECK. It cannot ask the chain which factory is
 * configured - that lives in the deployment's environment, and the honest way to read
 * it is the production bundle, which the document now says. What it CAN check is the
 * half that is pure drift: the constants the document quotes are the constants the app
 * computes with, and the superseded address is not quietly also the current one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXED_CURVE, FIXED_LP_RESERVE } from '../launchLimits.ts';

const DOC = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'evm', 'DEPLOYED.md'),
  'utf8',
);

/** A `1,234,000,000 x 1e18` figure out of the document, as base units. */
function wholeTimes1e18(label: string): bigint {
  const m = new RegExp(`${label}\\s+([\\d,]+) x 1e18`).exec(DOC);
  assert.ok(m, `the document no longer states ${label}, so this guard measures nothing`);
  return BigInt(m[1].replace(/,/g, '')) * 10n ** 18n;
}

test('the curve constants the document quotes are the ones the app computes with', () => {
  /*
   * THE DIVERGENCE THAT WOULD HURT. The create form draws the curve and quotes the
   * opening price from `FIXED_CURVE`, and the factory builds the launch from its own
   * immutable copies. If the two disagree, the form quotes one curve and creates
   * another, with nothing on the page saying so - and the document is where anyone
   * would go to check which is right.
   */
  assert.equal(wholeTimes1e18('CURVE_SUPPLY'), FIXED_CURVE.curveSupply);
  assert.equal(wholeTimes1e18('LP_RESERVE'), FIXED_LP_RESERVE);
  assert.equal(wholeTimes1e18('VIRTUAL_TOKENS'), FIXED_CURVE.virtualTokens);
});

test('the document names one current factory, and the superseded one is not it', () => {
  const current = /^factory\s+(0x[0-9a-fA-F]{40})/m.exec(DOC);
  assert.ok(current, 'the document no longer states a factory address');

  /*
   * The stale address is kept in the document ON PURPOSE, labelled as superseded, so
   * that somebody holding it from an old note can tell. This asserts it has not crept
   * back into the `factory` line - which is the one a reader copies.
   */
  const stale = '0xD31966ef9d26C589996935359A567eeF9Ef1a59D';
  assert.ok(DOC.includes(stale), 'the superseded factory is no longer named, so a stale note cannot be recognised');
  assert.notEqual(
    current[1].toLowerCase(),
    stale.toLowerCase(),
    'the document names the superseded factory as the live one',
  );

  // And the verify command points at the current one, not at whatever it used to.
  const verify = /verify-deployment\.sh\s+(0x[0-9a-fA-F]{40})/.exec(DOC);
  assert.ok(verify, 'the document no longer shows how to verify a deployment');
  assert.equal(
    verify[1].toLowerCase(),
    current[1].toLowerCase(),
    'the verify command checks a different factory than the document calls live',
  );
});

test('the measured log cap in the document is the one the trade reader uses', async () => {
  /*
   * The document states `maximum [from, to] blocks distance: 10000` as a measurement
   * and the reader pages against `LOG_RANGE_CAP`. Two copies of a measured limit is
   * the mirrored-constant defect; this is the cheap half of keeping them one.
   */
  const { LOG_RANGE_CAP } = await import('./trades.ts');
  const m = /blocks distance: (\d+)/.exec(DOC);
  assert.ok(m, 'the document no longer records the measured log range cap');
  assert.equal(BigInt(m[1]), LOG_RANGE_CAP);
});
