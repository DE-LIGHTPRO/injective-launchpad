/**
 * The portfolio read a 1000-denom prefix and called it a wallet.
 *
 * `allBalances` requested `?pagination.limit=1000`, typed the response as
 * `{balances}` with NO `pagination` field, and returned whatever arrived. Past 1000
 * denoms the remainder was dropped: holdings absent from the table, absent from the
 * per-quote totals, and nothing anywhere saying a read had been truncated. On a
 * screen whose only job is what an account is worth, a missing position and a sold
 * one look exactly the same.
 *
 * THE PREMISE HAD TO BE MEASURED FIRST, because this chain has endpoints that ignore
 * the page-size parameter and answer the full set - which is indistinguishable from a
 * honoured limit until the result exceeds it, and would have made this whole fix
 * ceremony. Measured against `testnet.sentry.lcd.injective.network` on 16 Oct 2026
 * with an account holding six denoms:
 *
 *     limit=1  -> 1 balance, next_key set     limit=6     -> 6 balances, next_key null
 *     limit=2  -> 2 balances, next_key set    limit=1000  -> 6 balances, next_key null
 *     limit=3  -> 3 balances, next_key set    (no param)  -> 6 balances, next_key null
 *
 * The limit is honoured, and `next_key` is set exactly when the answer is a prefix.
 * So completeness was a free read the whole time, and declining it was the defect.
 *
 * AND THE OTHER HALF, which the above does not establish: a node that EMITS a key need
 * not ACCEPT one back. Same account and endpoint, walked in pages of two:
 *
 *     limit=2                  -> 2 balances, next_key 'ZmFjdG9yeS9…VEVTVDQ1Mjk='
 *     limit=2 + that key       -> 200, the NEXT two balances, next_key 'aW5q' ("inj")
 *     three pages of two       -> 6 denoms, identical to one request of 1000
 *
 * The round trip is what makes the fix work rather than loop, and it had to be measured
 * separately: it is a different claim about the endpoint.
 *
 * MODELLED, NOT RECORDED. The thing under test is a sequence of requests, and a
 * fixture of one response cannot exercise it. The stub honours the limit for the same
 * reason `launch-paging.test.ts`'s does: one that returned everything regardless
 * would let the original unpaged code pass every assertion below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allBalances } from './wallet.ts';

const ADDR = 'inj1x339v5qxkvc5qa6lfagzcc7rvgl4v4usjytmfw';

/** Denoms the account holds, deterministic and ordered the way the bank module keys them. */
const denomAt = (i: number) => `factory/inj1creator/T${String(i).padStart(5, '0')}`;

/**
 * Three bytes that force a `+` into the base64, so the key is a key that NEEDS encoding.
 *
 * `0xFB 0xEF 0xBE` is four six-bit groups of 62, which is `++++`. Without this the
 * stub's keys were base64 of plain ASCII denoms and happened to contain no character a
 * query string treats specially, so sending the key RAW passed every assertion - the
 * encoding test was not a test. A `+` arrives as a space, which decodes to different
 * bytes, which on a real node resumes from a denom that does not exist: an empty page
 * and a silently truncated wallet, i.e. the original defect reached a different way.
 */
const KEY_MARKER = Buffer.from([0xfb, 0xef, 0xbe]);

const keyFor = (denom: string) =>
  Buffer.concat([KEY_MARKER, Buffer.from(denom)]).toString('base64');

/**
 * A bank endpoint that pages: `pagination.key` is the denom to resume AFTER, and
 * `next_key` is set when and only when the answer is a prefix.
 *
 * It REFUSES a key whose marker bytes did not survive the round trip, with the 400 a
 * real node would answer an unparseable key, rather than quietly resuming from the
 * beginning - a stub that forgives a mangled key cannot see the bug.
 */
function stubBank(total: number, opts: { nextKeyWhenDone?: '' | null; nextKeyOnFullPage?: boolean } = {}) {
  const real = globalThis.fetch;
  const seen: Array<{ limit: string | null; key: string | null }> = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    const limit = url.searchParams.get('pagination.limit');
    const key = url.searchParams.get('pagination.key');
    seen.push({ limit, key });

    let after = -1;
    if (key !== null) {
      const raw = Buffer.from(key, 'base64');
      if (!raw.subarray(0, 3).equals(KEY_MARKER)) {
        return new Response(JSON.stringify({ code: 3, message: 'invalid pagination key' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      after = Number(raw.subarray(3).toString().split('T')[1]);
    }
    const take = Math.min(Number(limit ?? 100), 100);
    const balances = [];
    for (let i = after + 1; i < total && balances.length < take; i += 1) {
      balances.push({ denom: denomAt(i), amount: String((i + 1) * 1_000) });
    }
    const last = after + balances.length;
    /*
     * A node that hands back a key on a full final page is the `nextKeyOnFullPage`
     * model: it has read `limit` rows and does not know whether a `limit+1`th exists,
     * so it offers a resume point that turns out to be empty. Both shapes are real,
     * and the caller must follow the SIGNAL rather than judge the page's size.
     */
    const done = opts.nextKeyOnFullPage ? balances.length < take : last >= total - 1;
    return new Response(
      JSON.stringify({
        balances,
        pagination: {
          next_key: done ? (opts.nextKeyWhenDone ?? null) : keyFor(denomAt(last)),
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

async function withBank<T>(
  total: number,
  fn: (seen: ReturnType<typeof stubBank>['seen']) => Promise<T>,
  opts: { nextKeyWhenDone?: '' | null; nextKeyOnFullPage?: boolean } = {},
): Promise<T> {
  const stub = stubBank(total, opts);
  try {
    return await fn(stub.seen);
  } finally {
    stub.restore();
  }
}

test('a wallet past one page reports every denom it holds', async () => {
  /*
   * 250 against a stub capped at 100 forces three pages. The old code would have
   * returned 100 of them and the portfolio would have shown a smaller wallet with
   * total confidence.
   */
  const b = await withBank(250, () => allBalances(ADDR));
  assert.notEqual(b, null, 'a paged read came back as a failure');
  assert.equal(Object.keys(b!).length, 250, 'denoms went missing from the wallet');
  assert.equal(b![denomAt(0)], 1_000n, 'the first page is wrong');
  assert.equal(b![denomAt(249)], 250_000n, 'the last denom is not in the result');
});

test('it resumes from the key the node handed back, encoded', async () => {
  await withBank(250, async (seen) => {
    await allBalances(ADDR);
    assert.ok(seen.length >= 3, `250 denoms over pages of 100 made ${seen.length} requests`);
    assert.equal(seen[0].key, null, 'the first request must not carry a resume key');
    /*
     * The decisive assertion, and it only decides because `keyFor` plants a `+` in
     * the key. `URL` decodes the parameter on the way in, so reading back the exact
     * base64 the stub emitted proves the caller encoded it on the way out.
     */
    assert.ok(keyFor(denomAt(99)).includes('+'), 'the fixture key needs no encoding, so this proves nothing');
    assert.equal(seen[1].key, keyFor(denomAt(99)));
    assert.equal(seen[2].key, keyFor(denomAt(199)));
  });
});

test('a complete answer costs one request', async () => {
  /*
   * ANTI-VACUITY, and the common case: almost every wallet holds a handful of denoms.
   * A fix that pages unconditionally would double the latency of the portfolio for
   * everyone to serve nobody, and `next_key` is exactly the signal that avoids it.
   */
  await withBank(6, async (seen) => {
    const b = await allBalances(ADDR);
    assert.equal(Object.keys(b!).length, 6);
    assert.equal(seen.length, 1, `a six-denom wallet made ${seen.length} requests`);
  });
});

test('the stopping condition is the key, not the size of the page', async () => {
  /*
   * A wallet of exactly 100 against a node that offers a resume key on every full
   * page. Two readings of the same answer, and only one is right:
   *
   *   by SHAPE   the page is full, so maybe there is more / it is short, so stop
   *   by SIGNAL  `next_key` is set, so there is more; it is null, so stop
   *
   * Judging by shape fails in both directions. Stopping on a full page is the
   * original truncation at a different number; stopping only when a page comes back
   * short would make a correct node that reports null on a full page cost a wasted
   * round trip, and leaves the caller reading a page size to decide a question the
   * node already answered.
   *
   * So the trailing empty page is deliberate here: following the key into nothing
   * must still yield all 100 denoms and terminate, rather than loop to the cap and
   * report a readable wallet as unreadable.
   */
  await withBank(
    100,
    async (seen) => {
      const b = await allBalances(ADDR);
      assert.notEqual(b, null, 'an empty trailing page was mistaken for a failure');
      assert.equal(Object.keys(b!).length, 100, 'a full page was treated as the end of the wallet');
      assert.equal(seen.length, 2, `the resume key was ${seen.length === 1 ? 'ignored' : 'followed too far'}`);
    },
    { nextKeyOnFullPage: true },
  );
});

test('an empty next_key ends it as surely as a null one', async () => {
  /*
   * Cosmos builds differ: some omit `next_key`, some send null, some send "". An
   * empty string is not a key to ask with, and treating it as one loops until the
   * page cap and then returns null - a working wallet reported as unreadable.
   */
  await withBank(6, async (seen) => {
    const b = await allBalances(ADDR);
    assert.equal(Object.keys(b!).length, 6, 'an empty next_key was mistaken for another page');
    assert.equal(seen.length, 1);
  }, { nextKeyWhenDone: '' });
});

test('an empty wallet is empty, and an unreachable node is not', async () => {
  /*
   * The distinction the whole module exists for, re-pinned here because the paging
   * loop now has several more ways to return early. `{}` means the bank answered and
   * the account holds nothing; `null` means nobody answered. The portfolio renders
   * them with different copy and must not be handed the wrong one.
   */
  const empty = await withBank(0, () => allBalances(ADDR));
  assert.deepEqual(empty, {}, 'an account holding nothing must not read as a failed read');

  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('upstream is down', { status: 503 })) as unknown as typeof fetch;
  try {
    assert.equal(await allBalances(ADDR), null, 'a 503 must not read as an empty wallet');
  } finally {
    globalThis.fetch = real;
  }

  globalThis.fetch = (async () => {
    throw new Error('network unreachable');
  }) as unknown as typeof fetch;
  try {
    assert.equal(await allBalances(ADDR), null, 'a thrown fetch must not read as an empty wallet');
  } finally {
    globalThis.fetch = real;
  }
});

test('past the page cap it returns unknown rather than a prefix', async () => {
  /*
   * The cap is a runaway guard, not a bound on real wallets: ten pages is 10,000
   * denoms. The one thing it must not do is become the original defect under a new
   * name, so it answers `null` - which the portfolio already renders as "balances
   * could not be read" - instead of handing back the first 10,000 as though that were
   * the account.
   */
  const b = await withBank(10_500, () => allBalances(ADDR));
  assert.equal(b, null, 'a truncated read was returned as if it were the whole wallet');
});
