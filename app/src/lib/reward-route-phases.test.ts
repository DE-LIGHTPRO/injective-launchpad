/**
 * A LAUNCH HAS TWO PHASES AND THE POOL ROUTE ONLY EVER REACHED THE FIRST.
 *
 * A creator picking "To the pool" gives up their share of every fee so it deepens the
 * liquidity instead. `apply_route` implemented that by adding the cut to `lp_bonus`,
 * which is correct while the curve is running: `lp_bonus` is quote held out of
 * `inj_collected` so it cannot move the curve, and `seed_pool` pairs it into the pool
 * at graduation.
 *
 * `seed_pool` is `lp_bonus`'s only consumer, it runs once, and it returns
 * `ContractError::Graduated` if called again. So after graduation the same line put
 * the creator's share into a bucket nothing could ever move: not claimable, not part
 * of the reserve, not spendable, just quote in the contract's bank balance against a
 * counter that only goes up. Measured by the probe that became
 * `a_pool_routed_launch_still_routes_to_the_pool_after_graduation`:
 *
 *     the creator's share is stranded in lp_bonus: 15000000000000000
 *
 * from a single 3-quote pool buy. The pool phase is the rest of the launch's life, so
 * this is most of a Pool-routed launch rather than an edge of it.
 *
 * WHY NOTHING SAW IT, established rather than assumed:
 *
 *   - `assert_solvent()` counts `lp_bonus` as owed, which is right before graduation
 *     and is exactly why it could not see a stranded unit after. The assertion that
 *     does see it is the exact-balance one: `balance == pool_quote + creator_owed +
 *     platform_owed`, with no `lp_bonus` term, because after graduation there is no
 *     honest claimant for a non-zero one.
 *   - every curve fixture took the default route, so no curve test ever exercised
 *     `RewardRoute::Pool` at all.
 *   - the factory's one Pool-route test (`integration.rs:1667`) makes a CURVE buy, so
 *     it measured the branch that worked.
 *
 * WHY A SOURCE GUARD on top of the Rust tests. The copy is the other half. The create
 * form's "To the pool" detail described the share as "paired into the liquidity at
 * graduation" - true of phase one, and the whole of what the contract could do - so
 * the sentence and the code agreed with each other and both stopped at the same wrong
 * place. A behavioural test cannot read a sentence, and the sentence is what a creator
 * decides on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REWARD_ROUTES, CREATOR_FEE_SHARE_BPS } from './launchLimits.ts';
import { parseRewardRoute } from './chain.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const CONTRACT = join(SRC, '..', '..', 'contracts', 'curve', 'src', 'contract.rs');

function contract(): string {
  return maskComments(readFileSync(CONTRACT, 'utf8'));
}

function route(value: 'creator' | 'pool'): string {
  const found = REWARD_ROUTES.find((r) => r.value === value);
  assert.ok(found, `no ${value} route is offered`);
  return found.detail;
}

test("the pool route's own branch is phase-aware", () => {
  /*
   * Pinned by the PROPERTY rather than the spelling: inside `RewardRoute::Pool` the
   * destination is chosen on `state.migrated`, the reserve on the true side and the
   * holding bucket on the false side. Getting those two the wrong way round is the
   * other version of this defect and fails here.
   */
  assert.match(
    contract(),
    /RewardRoute::Pool => \{\s*if state\.migrated \{\s*state\.pool_quote = state\.pool_quote\.checked_add\(creator_cut\)\?;\s*\} else \{\s*state\.lp_bonus = state\.lp_bonus\.checked_add\(creator_cut\)\?;\s*\}\s*\}/,
    'the pool route no longer picks its destination by phase',
  );
});

test("lp_bonus still has exactly one consumer, which is why the branch is needed", () => {
  /*
   * THE PREMISE, asserted rather than trusted. The post-graduation branch exists
   * because nothing drains `lp_bonus` a second time. If someone later gives it another
   * consumer - a top-up, a second seeding, a sweep - the reasoning above changes and
   * this test is where that shows up, instead of the branch quietly becoming wrong in
   * a direction nobody re-derived.
   */
  const rs = contract();

  const drains = rs.match(/state\.lp_bonus = Uint128::zero\(\)/g) ?? [];
  assert.equal(drains.length, 1, `lp_bonus is drained at ${drains.length} places, expected 1`);

  assert.match(
    rs,
    /fn seed_pool\([\s\S]*?state\.lp_bonus = Uint128::zero\(\);[\s\S]*?\n\}/,
    'the one drain is no longer inside seed_pool',
  );
  assert.match(
    rs,
    /fn seed_pool\([^)]*\)[^{]*\{\s*if state\.migrated \{\s*return Err\(ContractError::Graduated\);/,
    'seed_pool no longer refuses to run twice, so lp_bonus may have a second consumer',
  );
});

test('the pool route is described for both phases, not just graduation', () => {
  const detail = route('pool');

  // Phase one named: the share is held and paired in at graduation.
  assert.match(detail, /graduation/, 'the copy no longer says when the held share is paired in');

  /*
   * Phase two named. This is the assertion that fails on the sentence that shipped,
   * which ended at graduation and so described the shorter half of a launch's life.
   */
  assert.match(
    detail,
    /after (it|that|graduation)/,
    'the copy stops at graduation again, leaving the pool phase undescribed',
  );
  assert.match(
    detail,
    /reserve|liquidity/,
    'the copy no longer says where the share goes once the pool exists',
  );

  assert.match(
    detail,
    new RegExp(`${CREATOR_FEE_SHARE_BPS / 100}%`),
    'the copy no longer quotes the real share',
  );

  /*
   * And quotes it from the constant rather than typing the figure, which the line
   * above cannot tell apart: a hardcoded `70%` reads identically today and drifts
   * silently the day the split moves. The constant itself is pinned to the factory by
   * `execution-wiring.test.ts`, so this is the link that makes that pin reach the copy.
   */
  assert.match(
    maskComments(readFileSync(join(SRC, 'lib', 'launchLimits.ts'), 'utf8')),
    /value: 'pool',[\s\S]*?\$\{CREATOR_FEE_SHARE_BPS \/ 100\}%/,
    'the pool route types its share as a figure instead of reading the constant',
  );
});

test('an absent route is the default, an unknown one is not', () => {
  /*
   * The contract carries `#[serde(default)]` on `reward_route`, so a launch created
   * before the field existed answers without it and really is Creator-routed. That is
   * a fact about the stored launch, not a guess, which is why absent resolves.
   *
   * A variant this build has never heard of is the opposite. Resolving it to
   * `creator` would tell that launch's creator their share is accruing and claimable
   * when the fees are going somewhere this build cannot name, and "the field was
   * missing so assume the one that promises money" is how a default becomes a claim.
   */
  assert.equal(parseRewardRoute(undefined), 'creator', 'an old launch no longer reads as Creator-routed');
  assert.equal(parseRewardRoute(null), 'creator');
  assert.equal(parseRewardRoute('creator'), 'creator');
  assert.equal(parseRewardRoute('pool'), 'pool');

  for (const unknown of ['holders', 'burn', 'Pool', '', 0, {}, []]) {
    assert.equal(
      parseRewardRoute(unknown),
      null,
      `${JSON.stringify(unknown)} was resolved to a route instead of refused`,
    );
  }
});

test('the fees panel reads the route rather than assuming the creator is paid', () => {
  /*
   * THE DISCLOSURE HALF. On a Pool-routed launch `creator_owed` is zero for the life
   * of the launch, and this panel told every reader "70% of it is the creator's",
   * rendered a "Creator's share, unclaimed" row of 0.000000, and offered its creator
   * a button whose copy read "This sends your 0.000000 INJ to this wallet". The route
   * was not read from the contract config at all, so the app could not have known.
   */
  const src = maskComments(readFileSync(join(SRC, 'components', 'FeeEarnings.tsx'), 'utf8'));

  assert.match(src, /rewardRoute: RewardRoute \| null;/, 'the panel no longer requires a route');
  assert.doesNotMatch(src, /rewardRoute\?:/, 'the route is optional, so a caller can omit it into the default');
  assert.match(src, /const toPool = rewardRoute === 'pool'/, 'the panel no longer distinguishes a pool route');
  assert.match(src, /const routeUnknown = rewardRoute === null/, 'an unrecognised route is treated as a known one');

  /*
   * The claim copy is gated on the BALANCE as well as the route, so a real owed
   * figure is still named as the creator's whatever the route says. Pinned because
   * gating on the route alone is the plausible simplification, and it hides money.
   */
  assert.match(
    src,
    /isCreator && creatorOwed > 0n/,
    'the creator claim copy no longer checks there is anything to send',
  );

  // And the route actually reaches it, which is the half rule 52 is about.
  const page = maskComments(
    readFileSync(join(SRC, 'app', 'launch', '[slug]', 'page.tsx'), 'utf8'),
  );
  assert.match(page, /rewardRoute=\{detail\.rewardRoute\}/, 'the launch page does not pass the route it read');

  const chain = maskComments(readFileSync(join(SRC, 'lib', 'chain.ts'), 'utf8'));
  assert.match(
    chain,
    /rewardRoute: parseRewardRoute\(cfg\.reward_route\)/,
    'the chain mapper no longer reads reward_route off the contract config',
  );
});

test('only the creator route promises a claim', () => {
  /*
   * ANTI-VACUITY, and the discrimination that matters to a creator reading the two
   * options side by side: a Pool-routed launch has `creator_owed` permanently zero, so
   * any "you claim it" wording under "To the pool" is a promise the contract cannot
   * keep. The creator route must carry it and the pool route must not.
   */
  assert.match(route('creator'), /claim/, 'the creator route no longer says the share is claimable');
  assert.doesNotMatch(route('pool'), /claim/, 'the pool route promises a claim that never accrues');
  assert.notEqual(route('pool'), route('creator'), 'the two routes are described identically');
});
