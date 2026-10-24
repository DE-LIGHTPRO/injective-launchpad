import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';
import {
  decideGas,
  describeBroadcastFailure,
  GAS,
  GAS_SIMULATION_MARGIN,
  GENERIC_CHAIN_REFUSAL,
  gasLimitFor,
} from './broadcast.ts';
import { simulateRawTx } from './txSimulate.ts';

/**
 * Does the chain get asked what would happen, before the user is asked to sign?
 *
 * AUDIT F-09, SECOND HALF. `broadcast.ts`'s own docblock claimed "`simulateLaunch` exists
 * so that failure happens before a wallet prompt" and no such function had ever been
 * written. It was the fourth bullet of the argument for shipping an unexercised
 * transaction builder, the one covering the residual risk the other three do not, and
 * the only one of the four resting on code. A reader who sees a risk named and answered
 * stops looking for it, so a comment that answers it with nothing is worse than a
 * comment that says nothing.
 *
 * The defect this guards against now is the next one over: a simulation that exists and
 * is never called, or one that is called and fails CLOSED, turning an unreachable LCD
 * into a refusal of the user's trade.
 */

const LIB = import.meta.dirname;
const code = (p: string) => maskComments(readFileSync(p, 'utf8'));
const BROADCAST = code(join(LIB, 'broadcast.ts'));

test('the measured limit carries a margin, and a trivial message still pays for a transaction', () => {
  /*
   * A simulation measures one block's state and the transaction executes against a later
   * one, so the margin is for the drift between them. Asserted as a relationship rather
   * than against hardcoded outputs: the point is that the margin is applied at all and
   * that lowering it to 1 fails here.
   */
  assert.ok(GAS_SIMULATION_MARGIN > 1, 'a margin of 1 or less declares exactly what was measured');
  assert.equal(gasLimitFor(400_000), Math.ceil(400_000 * GAS_SIMULATION_MARGIN));
  assert.ok(
    gasLimitFor(250_000) > 250_000,
    'the declared limit is not above what was measured, so normal drift runs it out of gas',
  );
  // A floor, because a measurement of a trivial message is still a transaction.
  assert.ok(gasLimitFor(1) >= 120_000, 'a tiny measurement declares a limit no transaction can fit');
  assert.ok(gasLimitFor(0) >= 120_000, 'a zero measurement produced a zero limit');
});

test('the measured limit is cheaper than the flat fallback it replaces', () => {
  /*
   * THE REASON THIS CHANGED AT ALL, and it is a measurement rather than an opinion. The
   * comment defending the flat limits said an over-estimate "costs the user nothing on
   * Injective's fee market". Fifty-six consecutive MsgExecuteContract transactions on
   * testnet, read 24 Oct 2026 near height 145,296,000, all had
   * `fee / gas_wanted == 500000000` exactly, while `fee / gas_used` scattered between
   * 513M and 615M: the declared fee is `gas_limit x price`, deducted in full, and
   * `gas_used` never enters it. An over-estimate costs exactly the over-estimate.
   *
   * A real execute on that chain measured 170k to 265k. Pinned against the observed top
   * of that range rather than a convenient number.
   */
  const measuredExecute = 265_000;
  assert.ok(
    gasLimitFor(measuredExecute) < GAS.trade,
    `a measured execute declares ${gasLimitFor(measuredExecute)} where the flat fallback ` +
      `declared ${GAS.trade}, so the fallback is not the cheaper option it was documented as`,
  );
});

test('a simulation that cannot be performed lets the user through', () => {
  /*
   * FAILING OPEN IS THE WHOLE DESIGN, and this is the half that must never invert. Our
   * LCD being unreachable is our outage; presenting it as the chain refusing the user's
   * trade would be strictly worse than not simulating at all, because it blocks a
   * transaction that would have worked.
   *
   * Every shape below is a real one: a thrown fetch and a non-JSON body both arrive as
   * null, our own rate limiter answers `{unavailable}`, and a truncated or re-shaped
   * response is what a deployment skew looks like.
   */
  const FALLBACK = GAS.trade;
  for (const [what, body] of [
    ['a thrown fetch or unparseable body', null],
    ['an explicit unavailable', { unavailable: 'the simulation could not be performed' }],
    ['our own rate limiter', { unavailable: 'Too many requests from here.' }],
    ['a body with no fields at all', {}],
    ['ok without a measurement', { ok: true }],
    ['a zero measurement', { ok: true, gasUsed: 0 }],
    ['a measurement that is not a number', { ok: true, gasUsed: 'lots' }],
    ['a negative measurement', { ok: true, gasUsed: -1 }],
    ['a measurement with ok absent', { gasUsed: 300_000 }],
    ['a string instead of an object', 'nope'],
    ['an empty refusal', { refused: '   ' }],
  ] as const) {
    const d = decideGas(body, FALLBACK);
    assert.equal(d.kind, 'gas', `${what} blocked the user instead of falling back`);
    assert.equal(d.kind === 'gas' && d.gas, FALLBACK, `${what} did not fall back to the fixed limit`);
    assert.equal(d.kind === 'gas' && d.measured, null, `${what} was recorded as a measurement`);
  }
});

test('a measurement is used, and a named refusal is the only thing that stops', () => {
  const measured = decideGas({ ok: true, gasUsed: 300_000 }, GAS.trade);
  assert.equal(measured.kind, 'gas');
  assert.equal(measured.kind === 'gas' && measured.gas, gasLimitFor(300_000));
  assert.equal(
    measured.kind === 'gas' && measured.measured,
    300_000,
    'a measured limit is indistinguishable from a fallback one',
  );

  const refused = decideGas(
    { ok: false, refused: 'The price moved past your slippage tolerance before this landed. Try again.', detail: 'raw' },
    GAS.trade,
  );
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.kind === 'refused' && refused.detail, 'raw');
});

test('only a refusal we can name is pre-empted, which is what makes blocking safe', () => {
  /*
   * `txSimulate` decides refused-versus-unavailable by asking whether
   * `describeBroadcastFailure` produced anything more specific than its fallback. That
   * contract is what this asserts, from both ends: a reason we recognise must not equal
   * the generic sentence, and an unrecognised one must equal it EXACTLY, because an
   * `includes` or a reworded copy would turn every unexplained failure into a block.
   */
  const named = [
    'failed to execute message: would receive 123 but asked for at least 456',
    'dispatch: submessage: launch caps a wallet at 100 tokens, you hold 60 and this buy would add 50',
    'trading opens at 1730000000',
    'denom factory/inj1x/ghdsjs already exists',
    'this launch is already in the locked pool',
    'nothing to claim',
    /*
     * THE WHOLE WRAPPED ERROR, not the interesting middle. The first version of this
     * fixture was the fragment the comment in `broadcast.ts` quotes, and it failed:
     * the branch keys on the words `insufficient funds`, which Cosmos appends when it
     * wraps `ErrInsufficientFunds` and which the quoted excerpt leaves out. The
     * translator was right and the fixture was claiming a capability nothing has - a
     * fixture that cannot discriminate, in the direction that invents a finding.
     */
    'failed to execute message; message index: 0: spendable balance 403213882356322213inj ' +
      'is smaller than 1000000000000000000inj: insufficient funds',
  ];
  for (const raw of named) {
    assert.notEqual(
      describeBroadcastFailure(raw),
      GENERIC_CHAIN_REFUSAL,
      `"${raw.slice(0, 40)}" is a refusal we could name and it fell through to the generic sentence, ` +
        `so it will reach the wallet prompt instead of being stopped before it`,
    );
  }
  for (const raw of ['', 'post failed: context deadline exceeded', 'EOF', 'rpc error: code = Unknown']) {
    assert.equal(
      describeBroadcastFailure(raw),
      GENERIC_CHAIN_REFUSAL,
      `"${raw}" was given a specific-looking translation, so an infrastructure failure ` +
        `would be pre-empted as though the chain had refused the trade`,
    );
  }
});

test('the generic sentence has exactly one definition', () => {
  /*
   * The refused-versus-unavailable decision is an equality against this constant, so a
   * second copy of the words is a silent inversion waiting: reword one and every
   * unexplained failure starts blocking users. Scanned over the two files that hold the
   * decision rather than asserted about one of them.
   */
  const files = [
    ['broadcast.ts', BROADCAST],
    ['txSimulate.ts', code(join(LIB, 'txSimulate.ts'))],
    ['txBroadcast.ts', code(join(LIB, 'txBroadcast.ts'))],
  ] as const;
  let literals = 0;
  for (const [rel, src] of files) {
    const hits = src.split('The chain refused the transaction').length - 1;
    if (rel !== 'broadcast.ts') {
      assert.equal(hits, 0, `${rel} writes the generic refusal out instead of importing it`);
    }
    literals += hits;
  }
  assert.equal(literals, 1, `the generic refusal is written ${literals} times, not once`);
});

test('the simulation runs before the wallet prompt, not beside it', () => {
  /*
   * REGISTERED IS NOT WIRED, and a simulation that runs after `signDirect` is worth
   * nothing at all: the user has already approved it. Asserted as an ordering in the
   * source, the way this codebase asserts the upload route's pre-parse checks, because
   * no unit test can see the order of two awaits in a function it cannot call without a
   * wallet and a chain.
   */
  const simAt = BROADCAST.search(/await simulateThroughOrigin\(/);
  const signAt = BROADCAST.search(/offline\.signDirect\(/);
  const refuseAt = BROADCAST.search(/kind === 'refused'/);
  assert.ok(simAt > 0, 'nothing calls simulateThroughOrigin: the simulation is dead code');
  assert.ok(signAt > 0, 'the signing call is gone; this guard needs re-pointing');
  assert.ok(simAt < signAt, 'the simulation runs AFTER the wallet prompt, which defeats it');
  assert.ok(
    refuseAt > 0 && refuseAt < signAt,
    'a refused simulation does not stop before the prompt, so the user approves a doomed transaction',
  );
});

test('every signing entry point goes through the path that simulates', () => {
  /*
   * There is one signing function and three exported ways in. A fourth added later that
   * composed and signed on its own would skip the simulation entirely while every test
   * here kept passing, which is the shape of the `AmmVenueAdapter` defect: reachable,
   * registered, and bypassing the thing that matters.
   *
   * Discovered from the source rather than listed, and anti-vacuous below.
   */
  /*
   * BOUNDARIES COME FROM THE MATCH INDICES, NOT FROM `indexOf(name)`, and the first
   * version used `indexOf` and let a mutation through. `broadcastExecute` is a PREFIX of
   * `broadcastExecuteDirect`, so `indexOf('export async function broadcastExecute')`
   * found the longer one, the next-boundary filter dropped it as not-after-itself, and
   * the slice ran on far enough to swallow the real function's `signAndBroadcast` call.
   * The added bypass was reported as covered by the body of the function it bypassed.
   *
   * `matchAll` already yields these in order with their positions. Anchoring on what was
   * actually matched rather than re-finding it by name is the same lesson as the
   * `try {` slice that emptied itself in Sealed's `cctp-speed-toggle` guard.
   */
  const found = [...BROADCAST.matchAll(/export async function (broadcast\w+)\s*\(/g)].map((m) => ({
    name: m[1],
    at: m.index,
  }));
  assert.ok(found.length >= 3, `found only ${found.length} broadcast entry points: the scan is not measuring`);
  for (let i = 0; i < found.length; i++) {
    const body = BROADCAST.slice(found[i].at, found[i + 1]?.at);
    assert.match(
      body,
      /signAndBroadcast\(/,
      `${found[i].name} does not go through signAndBroadcast, so it signs without simulating first`,
    );
  }
});

test('the claims this work falsified do not come back', () => {
  /*
   * Three user-facing or reader-facing sentences were false, and all three were false in
   * the same direction: each described a protection or a cost that was not there.
   */
  assert.doesNotMatch(
    BROADCAST,
    /costs the user nothing/,
    'the claim that an over-estimate is free is back, and 56 live transactions say the fee is gas_limit x price',
  );
  assert.doesNotMatch(
    BROADCAST,
    /estimate is raised automatically/,
    'the out-of-gas message again tells the user a retry raises an estimate that nothing raises',
  );
  // `simulateLaunch` may be named in prose about its absence, never as a call.
  assert.doesNotMatch(BROADCAST, /simulateLaunch\s*\(/, 'something calls a simulateLaunch that does not exist');
});

test('the node\'s real response shapes are parsed, in the node\'s own spelling', async () => {
  /*
   * EVERY BODY BELOW WAS MEASURED OFF A LIVE NODE on 24 Oct 2026, not invented, because
   * the defect this pins was a spelling. The first implementation read
   * `gasInfo.gasUsed`, which is the SDK's camelCase view of this payload; the node
   * itself answers `gas_info.gas_used`. That reads `undefined`, falls back, and fails
   * OPEN - so every simulation would have measured nothing, refused nothing, and looked
   * precisely like a working simulation. Nothing in a source read or an ordering
   * assertion can see a wrong field name.
   */
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const parts = { bodyBytes: 'AA==', authInfoBytes: 'AA==', signatures: ['AA=='] };
  const run = (status: number, body: unknown) =>
    simulateRawTx(parts, { fetchImpl: reply(status, body), lcdUrl: 'https://node.test' });

  // A real ORBIT curve buy, measured through this very route.
  const ok = await run(200, { gas_info: { gas_wanted: '150000000', gas_used: '249433' }, result: {} });
  assert.deepEqual(ok, { ok: true, gasUsed: 249433 }, 'the node\'s own gas_info.gas_used was not read');

  /*
   * THE SDK'S SPELLING MUST NOT BE READ AS A MEASUREMENT. This is the exact body the
   * discarded `TxRestApi.simulate` path would have produced, and it must come back as no
   * verdict rather than as a measurement of nothing.
   */
  const camel = await run(200, { gasInfo: { gasUsed: '249433' } });
  assert.equal(camel.ok, false, 'a camelCase body was accepted as a measurement');
  assert.ok('unavailable' in camel, 'a camelCase body was treated as a refusal rather than no verdict');

  // A refusal, in the node's words, which our translator recognises.
  const refused = await run(500, {
    code: 2,
    message:
      "account sequence mismatch, expected 32729060, got 32729058: incorrect account sequence " +
      "[!injective!labs/cosmos-sdk@v0.50.15-inj.1/x/auth/ante/sigverify.go:290] With gas wanted: '150000000' and gas used: '68816' ",
  });
  assert.equal(refused.ok, false);
  assert.ok('refused' in refused && /still settling/.test(refused.refused), 'a named refusal was not translated');

  /*
   * A failure we cannot name, measured by posting undecodable bytes. It must be no
   * verdict: a tx parse error is our bug or a skew, never a reason to tell a user their
   * trade was refused.
   */
  const parse = await run(500, {
    code: 2,
    message: 'errUnknownField "*tx.TxBody": {TagNum: 13, WireType:"unknown type: 6"}: tx parse error',
  });
  assert.ok('unavailable' in parse, 'an undecodable transaction was reported as the chain refusing the trade');

  // And the shapes that are not shapes at all.
  for (const [what, status, body] of [
    ['a 200 with nothing in it', 200, {}],
    ['a 200 with gas_info but no number', 200, { gas_info: {} }],
    ['a zero measurement', 200, { gas_info: { gas_used: '0' } }],
    ['a 500 with no message', 500, { code: 2 }],
    ['a 502 from a proxy', 502, { nope: true }],
  ] as const) {
    const r = await run(status, body);
    assert.ok('unavailable' in r, `${what} did not come back as no verdict`);
  }
});

test('the simulate route is reachable, limited, and never reports a verdict it did not get', () => {
  const route = code(join(LIB, '..', 'app', 'api', 'simulate', 'route.ts'));
  assert.match(route, /export async function POST/, 'the simulate route has no POST');
  /*
   * `[\s\S]*?` AND NOT `[^)]*`. The first version was
   * `allowUploadShared\([^)]*bucket: 'broadcast'` and it failed on a correct route: the
   * argument is `clientKey(req)`, so the negated class ended at that nested `)` and the
   * match never reached the bucket. Exactly the failure recorded in
   * `nav-reachability.test.ts`, where `[^>]*` could not cross the `>` in an arrow
   * function and skipped the one control the test existed for.
   */
  assert.match(route, /allowUploadShared\([\s\S]*?bucket: 'broadcast'/, 'the simulate route is unlimited');
  /*
   * The route must not invent `refused`. Only `txSimulate` sets that field, and only
   * when it has a named reason: a route that answered `{refused}` for its own 400s would
   * block a user over a request-shape problem it caused.
   */
  assert.doesNotMatch(route, /refused:/, 'the simulate route sets `refused` itself rather than leaving it to txSimulate');
  assert.match(route, /unavailable:/, 'the route has no way to say it could not ask');
});
