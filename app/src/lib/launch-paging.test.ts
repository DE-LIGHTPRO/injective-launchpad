/**
 * The board showed the OLDEST fifty launches and every caller read it as "all".
 *
 * `Launches { start_after, limit }` ranges over the factory's id map ASCENDING and
 * the contract clamps `limit` to 100. `listLaunches` asked for one page of 50 and
 * never passed `start_after`, so from the fifty-first launch onward the newest ones
 * simply were not in the list. Measured against the live testnet factory over ids
 * 1-4: `limit=2` answers `1,2`, and `start_after=2` answers `3,4`.
 *
 * Nothing about that looks wrong. A board is a list of launches, and a list of
 * launches is what came back. What broke is everything that assumed completeness:
 *
 *  - `resolveLaunchSlug` matches against the list it is handed, so launch 51's page
 *    404s at the URL the product itself generates for it.
 *  - `launchSlug` appends an id only when it can see a clash in that same list, so a
 *    later launch reusing an earlier ticker stays invisible and `/launch/INJINU`
 *    quietly serves the older token - which `launchPath.ts` calls "the worst
 *    available outcome", in the guard this truncation defeats.
 *  - `ClaimFees` would tell a creator there is nothing to claim on a launch they are
 *    owed fees from.
 *  - Analytics renders the count as "Launches" under a promise that every figure is
 *    something the chain will answer for directly. It would have said 50 for ever.
 *
 * Invisible below fifty launches, which is to say it arrives exactly when the
 * launchpad starts working. These tests drive the paging through a stubbed LCD,
 * because the defect is in which requests get made rather than in what any one of
 * them returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { listLaunches } from './chain.ts';

const FACTORY = 'inj1factorytestonlyxxxxxxxxxxxxxxxxxxxxxxx';

/** What the contract stores for a launch, trimmed to what paging cares about. */
const launchAt = (id: number) => ({
  id,
  denom: `factory/inj1creator/T${id}`,
  creator: 'inj1creator',
  curve: `inj1curve${id}`,
  profile: null,
});

/**
 * An LCD that behaves like the factory does: ascending by id, `start_after`
 * exclusive, `limit` clamped to 100.
 *
 * Modelled rather than recorded, because the thing under test is a sequence of
 * requests and a fixture of one response cannot exercise it. The clamp is part of
 * the model on purpose: a stub that honoured `limit: 10000` would let a single
 * unpaged request pass every assertion below.
 */
function stubFactory(total: number) {
  const real = globalThis.fetch;
  const seen: Array<{ start_after?: number; limit?: number }> = [];
  globalThis.fetch = (async (url: string) => {
    const b64 = String(url).split('/smart/')[1];
    const q = JSON.parse(Buffer.from(decodeURIComponent(b64), 'base64').toString()) as {
      launches: { start_after?: number; limit?: number };
    };
    const { start_after, limit } = q.launches;
    seen.push({ start_after, limit });
    const capped = Math.min(limit ?? 30, 100);
    const launches = [];
    for (let id = (start_after ?? 0) + 1; id <= total && launches.length < capped; id += 1) {
      launches.push(launchAt(id));
    }
    return new Response(JSON.stringify({ data: { launches } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

async function withFactory<T>(total: number, fn: (seen: ReturnType<typeof stubFactory>['seen']) => Promise<T>) {
  const prev = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const prevDemo = process.env.NEXT_PUBLIC_DEMO;
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = FACTORY;
  process.env.NEXT_PUBLIC_DEMO = '';
  const stub = stubFactory(total);
  try {
    return await fn(stub.seen);
  } finally {
    stub.restore();
    if (prev === undefined) delete process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    else process.env.NEXT_PUBLIC_FACTORY_ADDRESS = prev;
    if (prevDemo === undefined) delete process.env.NEXT_PUBLIC_DEMO;
    else process.env.NEXT_PUBLIC_DEMO = prevDemo;
  }
}

test('a launchpad past one page returns every launch, not the oldest page of them', async () => {
  await withFactory(250, async () => {
    const all = await listLaunches();
    assert.equal(all.length, 250, 'launches went missing');
    assert.equal(all[0].id, 1);
    assert.equal(all[all.length - 1].id, 250, 'the newest launch is not in the list');
    // Every id exactly once: a paging bug that overlaps is as wrong as one that gaps.
    assert.deepEqual([...new Set(all.map((l) => l.id))].length, 250);
  });
});

test('the newest launches are the ones a single page would have dropped', async () => {
  /*
   * Anti-vacuity, and the reason this defect is severe rather than cosmetic. The
   * range is ascending, so truncation removes the launches a launchpad most needs to
   * show. If the contract paged descending the old code would have been merely
   * incomplete instead of actively hiding today's launches.
   */
  await withFactory(120, async (seen) => {
    const all = await listLaunches();
    const firstPage = all.slice(0, 100).map((l) => l.id);
    assert.deepEqual(firstPage[0], 1);
    assert.deepEqual(firstPage[99], 100);
    assert.ok(
      all.slice(100).every((l) => l.id > 100),
      'the second page did not carry the newer launches',
    );
    assert.ok(seen.length > 1, 'only one request was made, so nothing was paged');
  });
});

test('it pages from the last id it saw, exclusively', async () => {
  await withFactory(250, async (seen) => {
    await listLaunches();
    assert.equal(seen[0].start_after, undefined, 'the first page must start at the beginning');
    assert.equal(seen[1].start_after, 100);
    assert.equal(seen[2].start_after, 200);
    // And it asks for the contract's own cap, so no request is wasted on a short page.
    assert.ok(seen.every((s) => s.limit === 100), `a page asked for ${seen.map((s) => s.limit)}`);
  });
});

test('a short page ends it, so a small launchpad costs one request', async () => {
  /*
   * The stopping condition, which is the half that can loop for ever. A board render
   * on a quiet launchpad must not pay for a second round trip to learn there is
   * nothing after the first.
   */
  await withFactory(4, async (seen) => {
    const all = await listLaunches();
    assert.equal(all.length, 4);
    assert.equal(seen.length, 1, `a four-launch board made ${seen.length} requests`);
  });
});

test('an exactly-full page is followed up rather than assumed to be the end', async () => {
  /*
   * The off-by-one that would reintroduce the bug at a different number. 100 launches
   * fills a page exactly, and stopping there is indistinguishable from stopping at 50.
   */
  await withFactory(100, async (seen) => {
    const all = await listLaunches();
    assert.equal(all.length, 100);
    assert.equal(seen.length, 2, 'a full page was treated as the end of the list');
  });
});

test('an empty launchpad is empty, not an error', async () => {
  await withFactory(0, async (seen) => {
    assert.deepEqual(await listLaunches(), []);
    assert.equal(seen.length, 1);
  });
});

test('no factory configured reads as nothing, without touching the network', async () => {
  const prev = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const real = globalThis.fetch;
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '';
  globalThis.fetch = (() => {
    throw new Error('listLaunches queried with no factory configured');
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(await listLaunches(), []);
  } finally {
    globalThis.fetch = real;
    if (prev === undefined) delete process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    else process.env.NEXT_PUBLIC_FACTORY_ADDRESS = prev;
  }
});

test('past the page bound it throws rather than returning a short list', async () => {
  /*
   * The bound exists to stop a runaway loop, and the one thing it must not do is
   * become the old defect under a new name. 50 pages of 100 is 5,000 launches, well
   * past where this page would need a different shape; a throw is what makes that
   * visible instead of silently showing the oldest 5,000.
   */
  await withFactory(5_100, async () => {
    await assert.rejects(() => listLaunches(), /more launches than this page can read/i);
  });
});
