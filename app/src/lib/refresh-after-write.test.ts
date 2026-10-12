import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describeBroadcastFailure } from './broadcast.ts';

/**
 * A component that changes chain state must make the page read it again.
 *
 * THE DEFECT THIS EXISTS FOR, reported from production. A creator opened a launch,
 * saw "Creator's share, unclaimed 0.162037 INJ", clicked "Pay out fees" and signed.
 * The claim LANDED. The panel kept showing 0.162037, because those figures are
 * server-rendered props and nothing refetched them. So they clicked again, the
 * contract answered `nothing to claim`, and the translator turned that into "The
 * chain refused the transaction. Nothing was created and nothing was spent beyond
 * the fee."
 *
 * Three surfaces telling them the opposite of the truth at once: a balance that was
 * already paid out, a refusal that was the contract being correct, and a reassurance
 * that nothing had happened when the money had in fact moved. Measured on chain
 * afterwards: `creator_owed` and `platform_owed` were both zero.
 *
 * The trade panel had the identical bug and nobody had noticed, which is why this is
 * a guard over the class rather than a test of the claim button.
 */

const SRC = join(import.meta.dirname, '..');

/** Comment ranges blanked, so line numbers survive and prose can discuss the rule. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Components allowed to broadcast without `router.refresh()`, each with its reason.
 *
 * An allowlist rather than a loosened rule, so adding one is a decision somebody
 * writes down rather than a check that quietly stops applying.
 */
const EXEMPT: Record<string, string> = {
  // Fetches its own rows on the client and zeroes them on success, so there is no
  // server render to invalidate. The zero is the one figure it is safe to assume:
  // the claim either paid everything out or threw.
  'components/ClaimFees.tsx': 'client-fetched, and it clears its own rows',
};

test('every component that broadcasts also makes the page read the chain again', () => {
  const offenders: string[] = [];
  /*
   * THE RENDER TREE ONLY. `lib/broadcast.ts` defines these helpers and calls
   * `signAndBroadcast` from inside `broadcastExecuteMany`, so scanning `lib/` flags
   * the plumbing for not refreshing a page it knows nothing about. The rule is
   * about surfaces that show chain state, which live in `components/` and `app/`.
   */
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (!rel.startsWith('components/') && !rel.startsWith('app/')) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    // A write is a broadcast helper call, not merely importing one.
    const writes = /\b(broadcastExecute|broadcastExecuteMany|signAndBroadcast)\s*\(/.test(src);
    if (!writes) continue;
    if (rel in EXEMPT) continue;
    if (!/router\.refresh\(\)/.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These broadcast a transaction and leave the page showing what it was server-rendered with.\n' +
      `Call router.refresh() on success, or add a reason to EXEMPT:\n  ${offenders.join('\n  ')}`,
  );
});

test('the exemptions still point at files that exist', () => {
  /*
   * An allowlist entry for a deleted or renamed file is an exemption nobody can see
   * is dead, and the next file to take that path inherits it silently.
   */
  for (const rel of Object.keys(EXEMPT)) {
    assert.doesNotThrow(
      () => readFileSync(join(SRC, rel), 'utf8'),
      `${rel} is exempt and does not exist`,
    );
  }
});

test('a contract saying "nothing to claim" does not read as a refusal', () => {
  /*
   * The second half of the production report. `nothing to claim` is the contract
   * being correct about money that has already moved; "The chain refused the
   * transaction. Nothing was created and nothing was spent" says the opposite of
   * what happened and sends a creator looking for a bug.
   */
  const msg = describeBroadcastFailure(
    'failed to execute message; message index: 0: nothing to claim: execute wasm contract failed',
  );
  assert.match(msg, /already been paid out/i);
  assert.doesNotMatch(msg, /refused/i);
});

test('the fallback still covers an error nobody anticipated', () => {
  // The generic sentence has to stay for everything unrecognised, and it must not
  // leak the node's own text, which names module paths and reads as a crash.
  const msg = describeBroadcastFailure('rpc error: code = Unknown desc = something new');
  assert.match(msg, /chain refused/i);
  assert.doesNotMatch(msg, /rpc error|desc =/i);
});

test('an insufficient balance names what is needed and what is held', () => {
  /*
   * Reported from production twice in one evening: a creator with 0.403 INJ clicked
   * Create, signed, and got "The chain refused the transaction." Injective's own
   * refusal carries both numbers, and the previous message ("Not enough INJ to cover
   * the transaction fee") was wrong twice: the shortfall was the one-off 1 INJ
   * denom-creation charge, not gas, and a creator told it is "the fee" goes looking
   * at gas settings.
   */
  const msg = describeBroadcastFailure(
    'failed to execute message; message index: 0: spendable balance 403213882356322213inj ' +
      'is smaller than 1000000000000000000inj: insufficient funds',
  );
  assert.match(msg, /0\.4032/, `the held amount is missing: ${msg}`);
  assert.match(msg, /\b1 INJ\b/, `the required amount is missing: ${msg}`);
  assert.doesNotMatch(msg, /403213882356322213/, 'base units leaked to the reader');
});

test('an insufficient balance with no figures still says something useful', () => {
  // Not every node phrases it the same way, and the fallback must not be a crash or
  // a sentence with holes in it.
  const msg = describeBroadcastFailure('insufficient funds');
  assert.match(msg, /INJ/);
});
