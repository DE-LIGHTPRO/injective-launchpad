/**
 * The trade reader decodes a REAL log, and reports the window it read.
 *
 * TWO THINGS THIS HAD TO GET RIGHT AND ONE OF THEM I GOT WRONG FIRST.
 *
 * The decoding: `CURVE_ABI` declared no events at all, so `parseEventLogs` returned
 * an empty array for every log it was handed and the reader reported zero trades for
 * a launch whose own state says it has traded. My first test for this fed it
 * already-decoded shapes and passed over a reader that could never decode anything -
 * the same trap the error-copy test fell into, which is why this one encodes a log
 * the way the chain sends it and makes the reader decode it.
 *
 * The window: `eth_getLogs` on Injective's EVM refuses a range over 10,000 blocks
 * (measured: `-32000 maximum [from, to] blocks distance: 10000`), and at sub-second
 * blocks the live PAD launch was 256,818 blocks from the head - twenty-six requests.
 * So a full scan is not something a page load can do, and a list read over a window
 * must not be presented as a history. `complete` is what keeps that honest, and it
 * has to be false when there is a gap.
 */
process.env.NEXT_PUBLIC_NETWORK = 'evm';

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, type Log } from 'viem';

const { CURVE_ABI } = await import('./abi.ts');
const { LOG_RANGE_CAP, HEAD_PAGES, BIRTH_PAGES } = await import('./trades.ts');

const CURVE = '0x1EA823E09dB42Ca472182D8898bfaA40A64020F9' as const;
const BUYER = '0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb' as const;

/**
 * A `Bought` log exactly as the chain sends one: a topic hash, the indexed buyer in
 * `topics`, and the four unindexed values packed into `data`.
 *
 * THE VALUES ARE THE LIVE ONES. Read off the real curve on 30 Oct 2026 and
 * cross-checked against what the launch page already showed from the curve's own
 * state: 141,617.306515539948726768 tokens sold, 0.00004 INJ of fee owed out.
 */
function boughtLog(block: bigint): Log {
  const topics = encodeEventTopics({
    abi: CURVE_ABI,
    eventName: 'Bought',
    args: { buyer: BUYER },
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [4_000_000_000_000_000n, 141_617_306_515_539_948_726_768n, 40_000_000_000_000n, 0n],
  );
  return {
    address: CURVE,
    topics,
    data,
    blockNumber: block,
    logIndex: 0,
    transactionHash: '0xabc',
    blockHash: '0xdef',
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

/**
 * The stub chain's clock, shared by the stub and the assertions so they cannot
 * disagree about it.
 *
 * RECENT BLOCKS ARE SLOWER THAN OLD ONES, and that direction is the point.
 * `blockAtOrBefore` measures its stride from two recent blocks, so a slow recent era
 * makes the stride too LONG for an old target: dividing the elapsed seconds by it
 * gives too few blocks, the first guess lands nearer the head than the target, and
 * only reading that guess's own timestamp and stepping back finds a block at or
 * before it.
 *
 * I had it the other way round first - recent blocks fast - and the estimate then
 * undershot into block 0, whose timestamp satisfies any target, so the very first
 * probe succeeded and deleting the measured check changed nothing. The safe direction
 * for the code is the useless direction for the test.
 */
const SLOW_FROM = 800_000n;
function stubTime(block: bigint): number {
  const fast = block < SLOW_FROM ? block : SLOW_FROM;
  const slow = block < SLOW_FROM ? 0n : block - SLOW_FROM;
  // Half a second a block up to the change, two seconds a block after it.
  return Number(1_700_000_000n + fast / 2n + slow * 2n);
}

/**
 * A stub chain, so the window arithmetic can be exercised without 26 round trips.
 *
 * It records every range asked for, which is the half that matters: the point of the
 * two-window design is WHICH blocks get read, and that is invisible from the result.
 */
function stubClient(head: bigint, logsAt: Map<string, Log[]>) {
  const asked: Array<[bigint, bigint]> = [];
  return {
    asked,
    client: {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        assert.ok(
          toBlock - fromBlock < LOG_RANGE_CAP,
          `asked for ${toBlock - fromBlock + 1n} blocks, over the measured cap of ${LOG_RANGE_CAP}`,
        );
        asked.push([fromBlock, toBlock]);
        const out: Log[] = [];
        for (const [k, v] of logsAt) {
          const b = BigInt(k);
          if (b >= fromBlock && b <= toBlock) out.push(...v);
        }
        return out;
      },
      /*
       * A CHAIN THAT CHANGED PACE, which is what makes the measured check matter.
       *
       * The first version of this stub ran at a flat two blocks a second, and the
       * linear estimate therefore always landed at or before the target on its first
       * try - so deleting the `t <= targetSeconds` check entirely left every assertion
       * passing. A fixture that cannot discriminate is the guard failing.
       *
       * Here the last 200,000 blocks run four times SLOWER than the ones before them,
       * so the stride `blockAtOrBefore` measures from two recent blocks is four times
       * too long for an older target: its first guess lands nearer the head than the
       * target, and only reading that guess's own timestamp and stepping back gets to
       * a block at or before it. See `stubTime` for why this direction and not the
       * other.
       */
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        /*
         * A BIGINT, because that is what a block's timestamp is. `stubTime` returns a
         * number for the assertions' convenience and the first version handed that
         * straight back - which `node --test` accepted, because it strips types rather
         * than checking them, so thirteen tests passed over a stub that did not match
         * the interface it was standing in for. `tsc` caught it. The two checks this
         * project relies on are not interchangeable.
         */
        timestamp: BigInt(stubTime(blockNumber)),
      }),
    },
  };
}

/**
 * Runs the reader against the stub and hands back every range it asked for.
 *
 * `listTradesEvm` and `blockAtOrBefore` take the reader as a DEFAULTED PARAMETER, so
 * the stub goes in through the front door. The first version tried to swap
 * `read.evmClient` with `Object.defineProperty` and got "Cannot redefine property":
 * ESM exports are not writable, so there is no seam to be had from outside a module.
 * Same answer `executeManyEvm` already uses for its executor.
 */
async function withStub<T>(
  head: bigint,
  logsAt: Map<string, Log[]>,
  fn: (
    m: typeof import('./trades.ts'),
    c: ReturnType<typeof stubClient>['client'],
  ) => Promise<T>,
): Promise<{ out: T; asked: Array<[bigint, bigint]> }> {
  const trades = await import('./trades.ts');
  const { asked, client } = stubClient(head, logsAt);
  return { out: await fn(trades, client), asked };
}


test('a log is decoded from its topics and data, not from a shape handed in', async () => {
  const head = 1_000_000n;
  const block = head - 5n;
  const { out } = await withStub(head, new Map([[block.toString(), [boughtLog(block)]]]), (m, c) =>
    m.listTradesEvm(CURVE, 20, undefined, c),
  );

  assert.equal(out.trades.length, 1, 'the log was not decoded at all');
  const t = out.trades[0];
  assert.equal(t.kind, 'buy');
  // The indexed argument, which lives in `topics` rather than in `data`: declaring it
  // unindexed on the ABI would read the wrong bytes as the buyer without failing.
  assert.equal(t.who?.toLowerCase(), BUYER.toLowerCase());
  assert.equal(t.injIn, 4_000_000_000_000_000n);
  assert.equal(t.tokens, 141_617_306_515_539_948_726_768n);
  assert.equal(t.fee, 40_000_000_000_000n);
  assert.equal(t.refund, 0n);
  assert.equal(t.height, Number(block));
  // The block's time, fetched separately because a log carries none. Zero would stack
  // every trade at the epoch on a chart that buckets by it.
  assert.ok(t.time > 0, 'the trade has no block time');
});

test('no request ever exceeds the measured range cap', async () => {
  const head = 10_000_000n;
  const { asked } = await withStub(head, new Map(), (m, c) => m.listTradesEvm(CURVE, 20, undefined, c));
  assert.ok(asked.length > 0, 'nothing was read');
  for (const [from, to] of asked) {
    assert.ok(
      to - from < LOG_RANGE_CAP,
      `a page asked for ${to - from + 1n} blocks; the endpoint refuses over ${LOG_RANGE_CAP}`,
    );
  }
  // The head window, and no second window: no creation block was supplied.
  assert.equal(asked.length, HEAD_PAGES);
});

test('a launch born inside the head window is read whole, and says so', async () => {
  const head = 1_000_000n;
  const birth = head - 1_000n;
  const block = birth + 10n;
  const { out, asked } = await withStub(
    head,
    new Map([[block.toString(), [boughtLog(block)]]]),
    (m, c) => m.listTradesEvm(CURVE, 20, Number(birth), c),
  );
  assert.equal(out.trades.length, 1);
  assert.equal(out.complete, true, 'a contiguous read did not report itself complete');
  assert.equal(out.openingWindow, null, 'a second window was read for no reason');
  // Floored at the birth, so no blocks from before the launch existed were read.
  assert.equal(asked[asked.length - 1][0], birth);
});

test('a launch far from the head gets a second window at its creation', async () => {
  /*
   * THE CASE THAT WAS ON THE SCREEN. The live PAD launch is 256,818 blocks behind the
   * head and its only trade is in the page immediately after its creation; a head-only
   * scan reported zero trades for a launch whose own state says it has traded, which
   * is a measured-looking absence.
   */
  const head = 1_000_000n;
  const birth = head - 256_818n;
  const block = birth + 500n;
  const { out, asked } = await withStub(
    head,
    new Map([[block.toString(), [boughtLog(block)]]]),
    (m, c) => m.listTradesEvm(CURVE, 20, Number(birth), c),
  );

  assert.equal(out.trades.length, 1, 'the opening trade was not found');
  assert.ok(out.openingWindow, 'no window was read at the creation');
  assert.ok(
    BigInt(out.openingWindow.from) <= birth + 1n,
    'the opening window does not start at the launch',
  );

  /*
   * FALSE, AND THAT IS THE POINT. There is a quarter of a million blocks between the
   * two windows, so this list is not the history - and `complete` is the only thing
   * stopping the page printing "1 total".
   */
  assert.equal(out.complete, false);

  // Six requests, not twenty-six: that is the whole reason for two windows.
  assert.equal(asked.length, HEAD_PAGES + BIRTH_PAGES);
});

test('an unknown creation block leaves complete null, never false', async () => {
  /*
   * A third answer. `false` says "there is a gap", which is a claim; not knowing where
   * the launch began is not that claim, and the UI treats null as "cannot say".
   */
  const head = 1_000_000n;
  const { out } = await withStub(head, new Map(), (m, c) => m.listTradesEvm(CURVE, 20, undefined, c));
  assert.equal(out.complete, null);
});

test('the creation block is established from a measured timestamp, not from arithmetic', async () => {
  /*
   * The stub's blocks run at two per second (`1_793_000_000 + n/2`), which is not the
   * rate `blockAtOrBefore` assumes - it assumes nothing, and derives the stride from
   * two blocks it reads. The returned block's OWN timestamp must be at or before the
   * target, because that is the fact `complete` rests on.
   */
  const head = 1_000_000n;
  /*
   * A target in the SLOW era, reached across the pace change. The stride is measured
   * from two recent (fast) blocks, so the first linear guess lands well after the
   * target and the loop has to walk back - which is the only thing the measured check
   * does and the only way this test can tell it is there.
   */
  const target = stubTime(500_000n);
  const { out } = await withStub(head, new Map(), (m, c) => m.blockAtOrBefore(target, head, c));
  assert.notEqual(out, null, 'the creation block could not be established');
  assert.ok(
    stubTime(out!) <= target,
    `block ${out} has timestamp ${stubTime(out!)}, after the target ${target}`,
  );
  // On the safe side rather than exact: a floor slightly too low costs one page of
  // logs, a floor too high silently drops the oldest trades.
  assert.ok(out! <= head);

  /*
   * AND IT IS NOT MERELY THE LINEAR ESTIMATE. Computed the way the function opens -
   * head time minus elapsed, over a stride measured from the fast era - the first
   * guess is a block whose own timestamp is AFTER the target, so a version that
   * returned it would be wrong. Asserted, so this test fails if the pace change ever
   * stops making the estimate overshoot and the fixture goes back to not discriminating.
   */
  const headTime = stubTime(head);
  const stride = (headTime - stubTime(head - 10_000n)) / 10_000;
  const firstGuess = head - BigInt(Math.ceil((headTime - target) / stride));
  assert.ok(
    stubTime(firstGuess) > target,
    'the fixture no longer makes the linear estimate overshoot, so it cannot tell the measured check is there',
  );
  assert.notEqual(out, firstGuess, 'the unmeasured estimate was returned');
});
