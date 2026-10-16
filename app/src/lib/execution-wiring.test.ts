import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { maskComments } from './testing/maskComments.ts';

/**
 * Is the thing reachable, or only registered?
 *
 * THE DEFECT THIS EXISTS FOR. The trade panel's action was literally
 * `<button className="go" disabled>` with no handler anywhere in the file. Every quote
 * it rendered was correct and asserted against the Rust unit for unit; none of them
 * could be acted on. Separately, `creator_owed` and `platform_owed` accrued on every
 * trade and `ClaimFees` sat in the curve's `ExecuteMsg`, and a grep for any of those
 * names across the whole app returned nothing: the fees were earned and unclaimable.
 *
 * Both are the same failure and it is this project's most repeated one. The cause is
 * that the signing path took a `LaunchPlan`, so the only transaction the app could
 * send was a launch, and nothing about a correct quote or a passing contract test
 * reveals that. No runtime test can either: a disabled button renders, and a contract
 * message nobody sends is still a valid message. It has to be read off the source.
 */

const SRC = join(import.meta.dirname, '..');
const COMPONENTS = join(SRC, 'components');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/*
 * Comment ranges masked, so a disabled button described in prose is not a finding, and
 * so the prose below can name the literal it forbids. The shared helper rather than a
 * local one: a local copy here blanked the rest of any line holding an `https://`,
 * which is how a guard goes vacuous while the thing it watches is broken.
 */
const stripComments = maskComments;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('a screen with a primary action has one that can be pressed', () => {
  /*
   * NOT "no button is ever disabled". A first version asserted that and failed on
   * this panel's own `Demo: trading disabled` and `Connect wallet` fallbacks, which
   * are branches of a conditional and exactly right: a hardcoded `disabled` inside a
   * branch the user can leave is a correct way to say "not yet".
   *
   * What cannot be right is a file whose every primary action is hardcoded off, with
   * no branch that reaches a handler. That is what the trade panel was, and it is the
   * shape worth failing on.
   */
  const offenders: string[] = [];
  for (const file of readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx'))) {
    const src = stripComments(readFileSync(join(COMPONENTS, file), 'utf8'));
    const buttons = [...src.matchAll(/<button[^>]*className="go"[^>]*>/g)].map((m) => m[0]);
    if (buttons.length === 0) continue;
    const pressable = buttons.some((b) => /onClick/.test(b));
    if (!pressable) offenders.push(`${file}: ${buttons.length} primary action(s), none with a handler`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a screen offers a primary action that is drawn and cannot be pressed',
  );
});

test('every contract call the UI offers has a caller', () => {
  /*
   * Read from the components rather than from a list kept here, so a message added
   * to the contract and wired into a screen needs no edit to this test, and one
   * wired nowhere is what shows up.
   */
  const callers = readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => readFileSync(join(COMPONENTS, f), 'utf8'))
    .join('\n');

  for (const [msg, where] of [
    ['buy', 'TradePanel'],
    ['sell', 'TradePanel'],
    ['claim_fees', 'FeeEarnings'],
  ] as const) {
    assert.ok(
      callers.includes(`${msg}:`),
      `nothing sends \`${msg}\` (expected in ${where}); the contract accepts it and no screen reaches it`,
    );
  }
});

test('the signing path is reachable without a launch plan', () => {
  const broadcast = read('lib/broadcast.ts');
  assert.ok(
    /export async function broadcastExecute/.test(broadcast),
    'there is no way to sign a plain contract call',
  );
  /*
   * The specific regression: `broadcastLaunch` was the only export that signed, so
   * every other feature was drawn and dead. If this ever becomes the only signer
   * again, every button below the create form is decoration.
   */
  const signers = [...broadcast.matchAll(/export async function (broadcast\w+)/g)].map((m) => m[1]);
  assert.ok(signers.length >= 2, `only ${signers.join(', ')} can sign; a trade cannot`);
});

test('the fee split shown to a creator is the one the contract writes', () => {
  /*
   * A mirror is a second copy of a fact, and this is the one that would be read as a
   * promise: the create form tells a creator what share of every fee is theirs. The
   * authority is the Rust constant, so the test reads it rather than restating it.
   */
  const rust = readFileSync(
    join(SRC, '..', '..', 'contracts', 'factory', 'src', 'lib.rs'),
    'utf8',
  );
  const share = rust.match(/pub const CREATOR_FEE_SHARE_BPS: u16 = ([\d_]+);/);
  const supply = rust.match(/pub const FIXED_TOTAL_SUPPLY: Uint128 = Uint128::new\(([\d_]+)\);/);
  assert.ok(share && supply, 'the factory constants could not be read');

  const ts = read('lib/launchLimits.ts');
  const tsShare = ts.match(/export const CREATOR_FEE_SHARE_BPS = ([\d_]+);/);
  const tsSupply = ts.match(/export const FIXED_TOTAL_SUPPLY = ([\d_]+)n;/);
  assert.ok(tsShare && tsSupply, 'the mirrored constants could not be read');

  assert.equal(
    tsShare![1].replace(/_/g, ''),
    share![1].replace(/_/g, ''),
    'the form promises a different fee share than the contract writes',
  );
  assert.equal(
    tsSupply![1].replace(/_/g, ''),
    supply![1].replace(/_/g, ''),
    'the form states a different supply than the contract enforces',
  );

  /*
   * The opening-buy cap too. This one is the likeliest of the three to drift,
   * because its value was chosen against a measurement of this curve rather than
   * copied from anywhere, so there is nothing obvious to check it against by eye.
   */
  const rustCap = rust.match(/pub const MAX_INITIAL_BUY_BPS: u128 = ([\d_]+);/);
  const tsCap = ts.match(/export const MAX_INITIAL_BUY_BPS = ([\d_]+);/);
  assert.ok(rustCap && tsCap, 'the opening-buy cap could not be read from both sides');
  assert.equal(
    tsCap![1].replace(/_/g, ''),
    rustCap![1].replace(/_/g, ''),
    'the form allows a different opening buy than the contract does',
  );
});

test('the fixed supply is declared once, and it is the mirrored one', () => {
  /*
   * The mirror above is only worth having if it is the number the screens actually
   * divide by. `LaunchList` and `Portfolio` each declared their own
   * `1_000_000_000n * ONE` while `launchLimits.ts` held `FIXED_TOTAL_SUPPLY`
   * mirroring the factory: three copies of the figure that divides every price on the
   * board and every holding in the portfolio.
   *
   * What makes that worse than the usual duplicate is that it fails quietly and
   * proportionally. Change the supply in the factory, the test above goes red and
   * gets fixed in one place, and the board keeps pricing against the old number -
   * every figure on two screens wrong by the ratio, with nothing on either screen
   * looking unusual, because a price is a price.
   */
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === 'lib/launchLimits.ts') continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    const banned: [RegExp, string][] = [
      // The literal itself, underscored or not.
      [/1_?000_?000_?000_?000_?000_?000_?000_?000_?000/g, 'the supply as a literal'],
      // The shape it was actually written in: a billion scaled by a local token unit.
      [/1_000_000_000n\s*\*\s*\w+/g, 'a billion scaled by a local unit'],
      // And a second name for it, which is how the first two got there.
      [/(?:const|let)\s+(\w*TOTAL_SUPPLY\w*)\s*=/g, 'a local supply constant'],
    ];
    for (const [re, what] of banned) {
      for (const m of text.matchAll(re)) {
        offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length} ${what} (${m[0]})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'import FIXED_TOTAL_SUPPLY from launchLimits rather than restating it.\n  ' +
      offenders.join('\n  '),
  );

  /*
   * Anti-vacuity, and rule-52 reachability: forbidding the copies proves nothing if
   * the two screens no longer divide by the shared one either. Both call sites are
   * asserted, because the defect was one declaration per screen.
   */
  for (const rel of ['components/LaunchList.tsx', 'components/Portfolio.tsx']) {
    assert.match(
      stripComments(read(rel)),
      /\/ FIXED_TOTAL_SUPPLY/,
      `${rel} no longer values anything against the mirrored supply`,
    );
  }
});
