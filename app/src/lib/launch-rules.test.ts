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

  const tooBig = validateRules({ maxPerWallet: supply, tradeStart: null }, supply, now);
  assert.equal(tooBig.length, 1);
  assert.equal(tooBig[0].field, 'maxPerWallet');

  assert.equal(validateRules({ maxPerWallet: supply + 1n, tradeStart: null }, supply, now).length, 1);
  assert.equal(validateRules({ maxPerWallet: 0n, tradeStart: null }, supply, now).length, 1);

  // Just under is fine, which is the boundary the contract uses too.
  assert.deepEqual(validateRules({ maxPerWallet: supply - 1n, tradeStart: null }, supply, now), []);
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
  const problems = validateRules({ maxPerWallet: null, tradeStart: now - 1 }, supply, now);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, 'tradeStart');

  assert.deepEqual(validateRules({ maxPerWallet: null, tradeStart: now }, supply, now), []);
  assert.deepEqual(validateRules({ maxPerWallet: null, tradeStart: now + 60 }, supply, now), []);
});

test('the open boundary matches the contract exactly', () => {
  // Inclusive on both sides, or a launch opens a block later on one of them than the
  // other and the UI calls a live launch closed.
  const r = { maxPerWallet: null, tradeStart: 1_000 };
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
    { maxPerWallet: 1_000_000n * ONE, tradeStart: 1_900_000_000 },
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
  const { lines, scope } = describeRules({ maxPerWallet: 1_000n * ONE, tradeStart: null }, fmt, time);
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
  assert.equal(hasAnyRule({ maxPerWallet: null, tradeStart: 1 }), true);
  assert.equal(hasAnyRule({ maxPerWallet: 1n, tradeStart: null }), true);
});
