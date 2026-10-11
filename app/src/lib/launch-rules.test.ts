/**
 * Launch rules on the client, and the claim this file mostly exists to police.
 *
 * The feature is modelled on Hooked's transfer hooks, which Solana runs on every
 * transfer so a rule lives in the token itself. Injective has no equivalent: a
 * tokenfactory denom is a bank denom and a bank send runs no contract code. What this
 * product can enforce is every trade on the curve, which is every trade until the
 * launch graduates, and then nothing.
 *
 * So the wording is load-bearing. A rule described as a property of the token is a false
 * statement about what someone is buying, and these tests fail on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRules,
  rulesForChain,
  validateRules,
  buyingOpenAt,
  hasAnyRule,
  describeRules,
  NO_RULES,
  launchStatus,
  statusLabel,
  feeBpsAt,
  secondsUntilBaseFee,
  type LaunchRules,
} from './launchRules.ts';

const ONE = 10n ** 18n;
const fmt = (v: bigint) => `${v / ONE}`;
const time = (s: number) => new Date(s * 1000).toISOString();

test('a timestamp is read as nanoseconds, which is what CosmWasm sends', () => {
  /*
   * The defect this guards is silent in the dangerous direction. CosmWasm `Timestamp`
   * is nanoseconds as a string; read as seconds, every start lands in 1970, which
   * `buyingOpenAt` then reports as already open. The rule does not break visibly, it
   * just stops existing, on a launch whose creator was told it had a start time.
   */
  const seconds = 1_900_000_000;
  const parsed = parseRules({ trade_start: String(BigInt(seconds) * 1_000_000_000n) });
  assert.equal(parsed.tradeStart, seconds);

  // Round trip, since the two conversions are the pair that has to agree.
  assert.equal(rulesForChain({ maxPerWallet: null, tradeStart: seconds }).trade_start, '1900000000000000000');
});

test('absent rules parse as no rules rather than as zeros', () => {
  // A launch created before rules existed has no field at all, and a cap read as zero
  // would refuse every buy: the failure mode that turns an open launch into a dead one.
  for (const raw of [undefined, null, {}, 'nonsense', { max_per_wallet: null }]) {
    assert.deepEqual(parseRules(raw), NO_RULES, `${JSON.stringify(raw)} did not parse as open`);
  }
  assert.equal(hasAnyRule(NO_RULES), false);
});

test('a malformed value does not throw and blank the page', () => {
  // Contract state is data. One unparseable launch must not take down the list it is in.
  const r = parseRules({ max_per_wallet: 'not a number', trade_start: 'also not' });
  assert.equal(r.maxPerWallet, 0n);
  assert.equal(r.tradeStart, 0);
});

test('an absent rule is omitted from the message, never sent as zero', () => {
  assert.deepEqual(rulesForChain({ maxPerWallet: null, tradeStart: null }), {});
  // Zero is the same as absent on the way out: the contract refuses a zero cap, so
  // sending one turns "no rule" into a rejected launch.
  assert.deepEqual(rulesForChain({ maxPerWallet: 0n, tradeStart: null }), {});
  assert.deepEqual(rulesForChain({ maxPerWallet: 5n * ONE, tradeStart: null }), {
    max_per_wallet: (5n * ONE).toString(),
  });
});

test('a cap that could never bind is refused before a wallet opens', () => {
  /*
   * Same refusal the contract makes, surfaced in the form. A cap at or above the whole
   * curve supply is stored happily and does nothing, and displayed it reads as a
   * protection the launch does not have: a buyer takes "max 1,000,000,000 per wallet"
   * as a guarantee about distribution.
   */
  const supply = 800_000_000n * ONE;
  const now = 1_900_000_000;

  const tooBig = validateRules({ maxPerWallet: supply, tradeStart: null, earlyFee: null, openedAt: null }, supply, now);
  assert.equal(tooBig.length, 1);
  assert.equal(tooBig[0].field, 'maxPerWallet');

  assert.equal(validateRules({ maxPerWallet: supply + 1n, tradeStart: null, earlyFee: null, openedAt: null }, supply, now).length, 1);
  assert.equal(validateRules({ maxPerWallet: 0n, tradeStart: null, earlyFee: null, openedAt: null }, supply, now).length, 1);

  // Just under is fine, which is the boundary the contract uses too.
  assert.deepEqual(validateRules({ maxPerWallet: supply - 1n, tradeStart: null, earlyFee: null, openedAt: null }, supply, now), []);
});

test('a start time in the past is refused by the form though the chain allows it', () => {
  /*
   * The two are answering different questions and both are right. The chain cannot know
   * what a past timestamp meant and treats it as open. A form can: someone filling in a
   * start time wants a future one, and a past one means they got the date wrong, which
   * is permanent once the launch is created.
   */
  const supply = 800_000_000n * ONE;
  const now = 1_900_000_000;
  const problems = validateRules({ maxPerWallet: null, tradeStart: now - 1, earlyFee: null, openedAt: null }, supply, now);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, 'tradeStart');

  assert.deepEqual(validateRules({ maxPerWallet: null, tradeStart: now, earlyFee: null, openedAt: null }, supply, now), []);
  assert.deepEqual(validateRules({ maxPerWallet: null, tradeStart: now + 60, earlyFee: null, openedAt: null }, supply, now), []);
});

test('the open boundary matches the contract exactly', () => {
  // Inclusive on both sides, or a launch opens a block later on one of them than the
  // other and the UI calls a live launch closed.
  const r = { maxPerWallet: null, tradeStart: 1_000, earlyFee: null, openedAt: null };
  assert.equal(buyingOpenAt(r, 999), false);
  assert.equal(buyingOpenAt(r, 1_000), true);
  assert.equal(buyingOpenAt(r, 1_001), true);
  assert.equal(buyingOpenAt(NO_RULES, 0), true);
});

test('every description names the curve and names graduation', () => {
  /*
   * THE CLAIM GUARD. Hooked's rules live in the token and run on every transfer. These
   * live in the curve and stop at graduation. Describing them the first way would be a
   * false statement about what a buyer is holding, and it is the exact phrasing anyone
   * writing this copy would reach for.
   */
  const { lines, scope } = describeRules(
    { maxPerWallet: 1_000_000n * ONE, tradeStart: 1_900_000_000, earlyFee: null, openedAt: null },
    fmt,
    time,
  );
  assert.equal(lines.length, 2);

  const all = [...lines, scope].join(' ').toLowerCase();
  assert.match(all, /curve/, 'the copy never says where this is enforced');
  assert.match(all, /graduat/, 'the copy never says when it stops');

  for (const forbidden of [
    'every transfer',
    'on the token',
    'in the token',
    'built into the token',
    'cannot be transferred',
    'rules in the token',
  ]) {
    assert.ok(!all.includes(forbidden), `the copy claims "${forbidden}", which this chain cannot do`);
  }
});

test('the cap is described as what it is, not as a holdings guarantee', () => {
  /*
   * The cap counts buys minus sells through the curve. It is not a balance cap and
   * cannot be: the contract cannot see transfers, so someone can buy to the cap, send
   * the tokens elsewhere and buy again. Saying "holds at most" without "from this curve"
   * would be a guarantee about holdings that nothing enforces.
   */
  const { lines, scope } = describeRules({ maxPerWallet: 1_000n * ONE, tradeStart: null, earlyFee: null, openedAt: null }, fmt, time);
  const text = lines.join(' ').toLowerCase();
  assert.match(text, /from this curve/, 'the cap is described as a holdings cap');
  assert.match(text, /selling frees/, 'the copy does not say a sell frees allowance');
  // And the sybil limit is stated rather than left for the buyer to discover.
  assert.match(scope.toLowerCase(), /per address/, 'the copy does not say the cap is per address');
});

test('no rules means nothing is described', () => {
  // A launch with no rules must not render an empty "Rules" section, which reads as a
  // feature that failed to load rather than as a launch that has none.
  assert.equal(describeRules(NO_RULES, fmt, time).lines.length, 0);
  assert.equal(hasAnyRule(NO_RULES), false);
  assert.equal(hasAnyRule({ maxPerWallet: null, tradeStart: 1, earlyFee: null, openedAt: null }), true);
  assert.equal(hasAnyRule({ maxPerWallet: 1n, tradeStart: null, earlyFee: null, openedAt: null }), true);
});

test('a launch before its start time is not live', () => {
  /*
   * The defect this exists for shipped and was found by audit, not by use. Both the
   * list and the detail page derived the chip from `graduated` alone, so a launch whose
   * start time had not arrived was labelled "live": the most confident possible word on
   * the one state where the contract refuses every buy.
   */
  const pending = { maxPerWallet: null, tradeStart: 2_000, earlyFee: null, openedAt: null };
  assert.equal(launchStatus({ graduated: false, rules: pending, nowSeconds: 1_999 }), 'pending');
  assert.equal(launchStatus({ graduated: false, rules: pending, nowSeconds: 2_000 }), 'live');
  assert.equal(launchStatus({ graduated: false, rules: NO_RULES, nowSeconds: 0 }), 'live');
});

test('graduation outranks a start time', () => {
  // A launch that reached its target is past its start by definition, so reporting
  // "pending" there would be nonsense produced by checking the rules first.
  const weird = { maxPerWallet: null, tradeStart: 9_999_999_999, earlyFee: null, openedAt: null };
  assert.equal(launchStatus({ graduated: true, rules: weird, nowSeconds: 0 }), 'graduated');
  assert.equal(
    launchStatus({ graduated: true, migrated: true, rules: weird, nowSeconds: 0 }),
    'migrated',
  );
});

test('the pending label says what the contract does, not what marketing would', () => {
  // "Coming soon" is a promise; "not open yet" is a description of the gate. And the
  // tone is muted rather than accent, so a launch nobody can trade does not compete
  // with the ones they can.
  const { text, tone } = statusLabel('pending');
  assert.equal(text, 'not open yet');
  assert.equal(tone, 'muted');
  assert.equal(statusLabel('live').tone, 'accent');
  assert.equal(statusLabel('graduated').tone, 'warn');
  // A graduated launch trades against its locked pool, so it is tradable, not a warning.
  assert.deepEqual(statusLabel('migrated'), { text: 'in pool', tone: 'accent' });
});

test('the client fee mirrors the contract at every boundary', () => {
  /*
   * A client quote that disagrees with settlement is worse than no quote: it looks
   * right until the wallet opens. These are the same boundaries asserted in
   * `early_fee_tests` on the Rust side, written out again here rather than shared,
   * because the point is that two independent implementations agree.
   */
  const r: LaunchRules = {
    maxPerWallet: null,
    tradeStart: null,
    earlyFee: { startBps: 1_000, seconds: 100 },
    openedAt: 1_000,
  };
  assert.equal(feeBpsAt(r, 100, 1_000), 1_000, 'the opening block did not charge the opening fee');
  assert.equal(feeBpsAt(r, 100, 1_050), 100 + 450, 'halfway is not half the premium');
  assert.equal(feeBpsAt(r, 100, 1_099), 109, 'the last second charged nothing extra');
  assert.equal(feeBpsAt(r, 100, 1_100), 100, 'the decay did not finish on time');
  assert.equal(feeBpsAt(r, 100, 9_999), 100, 'a premium survived past its window');
  // Before the opening, which a start time makes reachable: zero elapsed, not negative.
  assert.equal(feeBpsAt(r, 100, 500), 1_000);
  // Rounding down, so an error favours the trader.
  const odd: LaunchRules = { ...r, earlyFee: { startBps: 110, seconds: 3 } };
  assert.equal(feeBpsAt(odd, 100, 1_001), 106, '10 * 2 / 3 should floor to 6');
});

test('no early fee means the curve fee, always', () => {
  assert.equal(feeBpsAt(NO_RULES, 100, 0), 100);
  assert.equal(secondsUntilBaseFee(NO_RULES, 0), null);
  // A rule with no `openedAt` cannot be timed, so it charges nothing extra rather
  // than guessing an origin: guessing "now" restarts the decay on every page load.
  const noOrigin: LaunchRules = {
    maxPerWallet: null, tradeStart: null, earlyFee: { startBps: 900, seconds: 60 }, openedAt: null,
  };
  assert.equal(feeBpsAt(noOrigin, 100, 12_345), 100);
});

test('the countdown ends exactly when the premium does', () => {
  const r: LaunchRules = {
    maxPerWallet: null, tradeStart: null, earlyFee: { startBps: 900, seconds: 60 }, openedAt: 1_000,
  };
  assert.equal(secondsUntilBaseFee(r, 1_000), 60);
  assert.equal(secondsUntilBaseFee(r, 1_059), 1);
  assert.equal(secondsUntilBaseFee(r, 1_060), null, 'the countdown outlived the premium');
  assert.equal(feeBpsAt(r, 100, 1_060), 100);
});

test('the opening fee says where the money goes', () => {
  /*
   * A higher fee with no explanation reads as the creator taking more, which is the
   * opposite of what this does. The destination is not a nicety: it is the only thing
   * that distinguishes an anti-sniper measure from a tax.
   */
  const { lines } = describeRules(
    { maxPerWallet: null, tradeStart: null, earlyFee: { startBps: 1_000, seconds: 600 }, openedAt: 1 },
    (v) => `${v}`,
    (s) => `${s}`,
  );
  const text = lines.join(' ').toLowerCase();
  assert.match(text, /pool/, 'the copy does not say where the premium goes');
  assert.match(text, /not to the creator/, 'the copy does not rule out the creator');
  assert.match(text, /sells are not affected/, 'the copy does not say this is buys only');
});

test('the opening fee says no wallet is exempt, which is a claim Pons cannot make', () => {
  /*
   * ponsfamily.com ships the same mechanism with a creator whitelist, and discloses
   * per card that "the creator exempted 32 wallets from the launch snipe tax, so they
   * could buy untaxed at the open". Disclosing it is honest; it is also a worse
   * product, because the fee exists to make the opening expensive and an exemption
   * hands that exact advantage to whoever the creator picks.
   *
   * There is no exemption in this contract and no field to add one, so the copy can
   * say so flatly. Pinned here because the sentence is only true while that stays
   * true: anyone adding a whitelist has to fail this test and delete the claim on
   * purpose rather than leave it standing.
   */
  const { lines } = describeRules(
    { maxPerWallet: null, tradeStart: null, earlyFee: { startBps: 1_000, seconds: 600 }, openedAt: 1 },
    (v) => `${v}`,
    (s) => `${s}`,
  );
  const text = lines.join(' ').toLowerCase();
  assert.match(text, /no wallet is exempt/, 'the guarantee is gone');
  assert.match(text, /including the creator/, 'the creator is not named as covered');
});
