/**
 * ONE UNREADABLE CURVE EMPTIED THE WHOLE LAUNCHPAD, on four pages at once.
 *
 * `loadRows` fanned every launch's detail out with a bare `Promise.all`. That rejects
 * on the FIRST failure, so a single curve the node would not answer for fell into the
 * function's catch and returned `{ rows: [] }` carrying that one curve's message as
 * the whole board's error. The home page, the portfolio, the watchlist and a creator's
 * fee totals all render that loader, and analytics had the same shape of its own.
 *
 * This is not a rare case. The LCD hostname is a load balancer, not a node: probed ten
 * times on 16 Oct 2026, `sentry.lcd.injective.network` reported a lowest available
 * height of ~100,000 blocks back eight times and ~30,600 twice, so a query one node
 * refuses another serves. "One read failed" happens on a healthy chain, and it should
 * cost that launch's row rather than the launchpad's front page.
 *
 * Fixing the blanking creates the obligation these tests mostly cover: the rows that
 * did load are now an INCOMPLETE list, and a board that silently serves a subset is
 * the silently-truncated list `listLaunches` was rewritten to fix, arriving by a
 * different route. So `unreadable` is part of the return type, not a log line, and it
 * carries the denom and the creator so a notice can NAME what is missing - "3 launches
 * could not be read" tells a holder nothing about whether theirs is one of them.
 *
 * The second defect in the same code was the fan-out being unbounded. Measured against
 * `testnet.sentry.lcd.injective.network` on 16 Oct 2026, 600 concurrent smart queries
 * from one host returned 50 OK and 550 `UND_ERR_CONNECT_TIMEOUT` throws, and the
 * degradation outlived the burst. On the server every visitor's board render shares one
 * instance's egress, so an unbounded board throttles the launchpad out of its own front
 * page - reported, through `smartQuery`'s catch, as the network being unreachable.
 *
 * These drive the real `loadRows` through a stubbed LCD, because the defect is in how
 * the requests are issued and what happens when one of them fails, not in what any one
 * response contains.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadRows } from './boardRows.ts';
import { DETAIL_CONCURRENCY } from './chain.ts';
import { FIXED_CURVE, FIXED_LP_RESERVE } from './launchLimits.ts';

const FACTORY = 'inj1factorytestonlyxxxxxxxxxxxxxxxxxxxxxxx';
const QUOTE = 'inj';

/** How a curve answers, per launch id. */
type CurveBehaviour = 'ok' | { status: number; body: string };

interface Stub {
  /** Peak number of LCD requests in flight at the same moment. */
  peak: number;
  restore: () => void;
}

/**
 * An LCD that answers for the factory and for each curve independently.
 *
 * Every curve read is delayed by a tick so overlap is observable - without it the
 * stub would resolve synchronously enough that an unbounded fan-out and a bounded one
 * would both measure a peak of one, and the concurrency assertion would pass on the
 * code it exists to reject.
 */
function stubChain(behaviour: Record<number, CurveBehaviour>, total: number): Stub {
  const real = globalThis.fetch;
  let inFlight = 0;
  const stub: Stub = { peak: 0, restore: () => { globalThis.fetch = real; } };

  globalThis.fetch = (async (url: string) => {
    inFlight += 1;
    stub.peak = Math.max(stub.peak, inFlight);
    try {
      const path = String(url);
      const contract = path.split('/contract/')[1].split('/smart/')[0];
      const query = JSON.parse(
        Buffer.from(decodeURIComponent(path.split('/smart/')[1]), 'base64').toString(),
      ) as Record<string, unknown>;

      const json = (data: unknown) =>
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (contract === FACTORY) {
        if ('quotes' in query) {
          return json({ quotes: [{ denom: QUOTE, decimals: 18 }], default_denom: QUOTE });
        }
        const { start_after } = query.launches as { start_after?: number };
        const launches = [];
        for (let id = (start_after ?? 0) + 1; id <= total && launches.length < 100; id += 1) {
          launches.push({
            id,
            denom: `factory/inj1creator/T${id}`,
            creator: 'inj1creator',
            curve: `inj1curve${id}`,
            profile: null,
          });
        }
        return json({ launches });
      }

      // A curve. Delayed on purpose; see above.
      await new Promise((r) => setTimeout(r, 2));
      const id = Number(contract.replace('inj1curve', ''));
      const how = behaviour[id] ?? 'ok';
      if (how !== 'ok') {
        return new Response(how.body, { status: how.status });
      }
      if ('config' in query) {
        return json({
          denom: `factory/inj1creator/T${id}`,
          quote_denom: QUOTE,
          creator: 'inj1creator',
          platform: 'inj1platform',
          lp_reserve: FIXED_LP_RESERVE.toString(),
          creator_fee_share_bps: 7000,
          /*
           * THE SHIPPED CURVE, read from the constant rather than retyped, because an
           * invalid one does NOT land in `unreadable`. `validate()` rejects a curve
           * whose supply reaches past its virtual reserve or whose target can never be
           * hit, and that throw happens in `graduationProgress` during the row-building
           * loop - past the per-launch catch, straight into the outer one, blanking the
           * board exactly the way the old `Promise.all` did. Two drafts of this fixture
           * did that, and every assertion below failed with a curve error instead of
           * the read failure it was testing: the fixture, not the assertion (and if the
           * launchpad's own curve ever stopped validating, that is worth a failure here
           * too).
           */
          curve: {
            virtual_inj: FIXED_CURVE.virtualInj.toString(),
            virtual_tokens: FIXED_CURVE.virtualTokens.toString(),
            curve_supply: FIXED_CURVE.curveSupply.toString(),
            graduation_target: FIXED_CURVE.graduationTarget.toString(),
            fee_bps: '100',
          },
        });
      }
      return json({
        inj_collected: '1000000000000000000',
        tokens_sold: '1000000000000000000000',
        graduated: false,
        migrated: false,
        platform_owed: '3000000000000000',
        creator_owed: '7000000000000000',
        platform_paid: '0',
        creator_paid: '0',
      });
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetch;

  return stub;
}

async function withChain<T>(
  behaviour: Record<number, CurveBehaviour>,
  total: number,
  fn: (stub: Stub) => Promise<T>,
): Promise<T> {
  const prevFactory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const prevDemo = process.env.NEXT_PUBLIC_DEMO;
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = FACTORY;
  process.env.NEXT_PUBLIC_DEMO = '';
  const stub = stubChain(behaviour, total);
  try {
    return await fn(stub);
  } finally {
    stub.restore();
    if (prevFactory === undefined) delete process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    else process.env.NEXT_PUBLIC_FACTORY_ADDRESS = prevFactory;
    if (prevDemo === undefined) delete process.env.NEXT_PUBLIC_DEMO;
    else process.env.NEXT_PUBLIC_DEMO = prevDemo;
  }
}

/** A 500 whose body is what the LCD really says for an address holding no contract. */
const NO_CONTRACT = {
  status: 500,
  body: JSON.stringify({ message: 'wasm code 22: no such contract: address inj1curve2' }),
};
/** A plain 500, which is what a struggling node answers. */
const NODE_TROUBLE = { status: 500, body: JSON.stringify({ message: 'internal' }) };

test('one unreadable curve costs its own row, not the board', async () => {
  await withChain({ 2: NODE_TROUBLE }, 4, async () => {
    const load = await loadRows();
    assert.equal(load.error, undefined, `the board reported an outage: ${load.error}`);
    assert.deepEqual(
      load.rows.map((r) => r.launch.id),
      [1, 3, 4],
      'the readable launches did not survive the unreadable one',
    );
  });
});

test('the launches that could not be read are named, not counted', async () => {
  /*
   * The denom is the whole point. A count cannot answer the question somebody opens a
   * board mid-incident to ask, which is whether their own token is one of the missing
   * ones, and the notice renders `symbolOf(denom)`.
   */
  await withChain({ 2: NODE_TROUBLE, 3: NO_CONTRACT }, 4, async () => {
    const { unreadable } = await loadRows();
    assert.deepEqual(
      unreadable.map((u) => u.id),
      [2, 3],
    );
    assert.deepEqual(
      unreadable.map((u) => u.denom),
      ['factory/inj1creator/T2', 'factory/inj1creator/T3'],
    );
    // And the creator, which is what lets the creator page scope the warning to the
    // person whose fee totals are actually short.
    assert.ok(unreadable.every((u) => u.creator === 'inj1creator'));
  });
});

test('a reason is carried per launch, so two different causes stay distinguishable', async () => {
  /*
   * One bad curve and a failing endpoint look identical from a count, and
   * `translateQueryError` is what tells them apart. Collapsing the reasons to the
   * first would hide exactly the case worth seeing.
   */
  await withChain({ 2: NO_CONTRACT, 3: NODE_TROUBLE }, 4, async () => {
    const { unreadable } = await loadRows();
    const reasons = unreadable.map((u) => u.reason);
    assert.match(reasons[0], /not found on this network/i);
    assert.match(reasons[1], /having trouble/i);
    assert.equal(new Set(reasons).size, 2, 'two different causes reported as one');
  });
});

/**
 * Values a transport can throw that are NOT Errors and carry no usable message.
 *
 * The notice interpolates `reason` directly, so a blank one renders as a sentence with
 * a hole in it, which reads as a bug in the page rather than as a gap in the read. What
 * actually guarantees it is not blank is `smartQuery`: it catches a fetch throw and
 * raises a `ChainError` with its OWN words, keeping the thrown value as `detail`. So
 * the reason is always a sentence somebody wrote, whatever the transport threw.
 *
 * TWO LAYERS HOLD THAT, AND EITHER ONE ALONE IS ENOUGH, which is why three earlier
 * drafts of this test claimed to exercise `loadRows`' `|| 'The curve did not answer.'`
 * fallback and could not. Mutation-verified: weakening the fallback to `??` kills
 * nothing, because `smartQuery` has already replaced the message; letting `smartQuery`
 * rethrow unwrapped kills nothing either, because the fallback then fires. Only
 * removing BOTH fails these - and then only for `new Error('')` and `{ message: '' }`,
 * since `??` still covers a value with no `message` at all.
 *
 * So what the last two cases pin is the settling rather than the wording: a transport
 * that throws something strange costs one row and names it, instead of taking the
 * board down or rendering a gap nobody can identify.
 */
const NOT_AN_ERROR: unknown[] = [new Error(''), { message: '' }, { nope: true }, 'plain string'];

for (const thrown of NOT_AN_ERROR) {
  test(`a transport throwing ${JSON.stringify(thrown) ?? 'an empty Error'} still names the gap`, async () => {
    await withChain({}, 2, async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        if (String(url).includes('inj1curve2')) throw thrown;
        return real(url as unknown as Request);
      }) as unknown as typeof fetch;
      try {
        const { rows, unreadable } = await loadRows();
        // Not a crash, and not an empty board: the other launch still renders.
        assert.deepEqual(rows.map((r) => r.launch.id), [1]);
        assert.equal(unreadable.length, 1);
        assert.equal(unreadable[0].id, 2);
        assert.ok(
          unreadable[0].reason.trim().length > 0,
          'the notice would render a sentence with a hole in it',
        );
      } finally {
        globalThis.fetch = real;
      }
    });
  });
}

test('a clean read reports no gap at all', async () => {
  /*
   * Anti-vacuity for every assertion above, and the thing a wrapper margin would
   * betray: `unreadable` must be empty rather than merely falsy on the normal path,
   * because five surfaces decide whether to render a banner from its length.
   */
  await withChain({}, 4, async () => {
    const load = await loadRows();
    assert.equal(load.rows.length, 4);
    assert.deepEqual(load.unreadable, []);
    assert.equal(load.error, undefined);
  });
});

test('nothing readable is an outage, not four little gaps', async () => {
  /*
   * The honest reading when every curve refuses is that the endpoint is not answering.
   * Reporting it as a notice over an empty board would say "4 launches could not be
   * read" and would lose the error copy `translateQueryError` picked, which is the half
   * that distinguishes a pruned height from a mistyped factory address.
   */
  await withChain({ 1: NODE_TROUBLE, 2: NODE_TROUBLE, 3: NODE_TROUBLE, 4: NODE_TROUBLE }, 4, async () => {
    const load = await loadRows();
    assert.deepEqual(load.rows, []);
    assert.match(load.error ?? '', /having trouble/i);
    // Still carried, so a page that renders both does not lose the detail.
    assert.equal(load.unreadable.length, 4);
  });
});

test('an empty launchpad is neither an error nor a gap', async () => {
  await withChain({}, 0, async () => {
    assert.deepEqual(await loadRows(), { rows: [], unreadable: [] });
  });
});

test('the detail fan-out is bounded, so a busy board cannot throttle the launchpad', async () => {
  /*
   * `getLaunchDetail` is two smart queries issued together, so the ceiling on requests
   * in flight is twice the detail concurrency. 40 launches unbounded would be 80 at
   * once; see `DETAIL_CONCURRENCY` for what the endpoint does to a burst.
   *
   * The bound is asserted against the exported constant rather than a literal, so
   * retuning it does not silently retune this test's idea of correct - only the
   * relationship is pinned.
   */
  const total = 40;
  await withChain({}, total, async (stub) => {
    const load = await loadRows();
    assert.equal(load.rows.length, total);
    assert.ok(
      stub.peak <= 2 * DETAIL_CONCURRENCY,
      `${stub.peak} requests were in flight at once, over the ${2 * DETAIL_CONCURRENCY} bound`,
    );
    // Anti-vacuity: a limit that was never reached proves nothing about the limit.
    assert.ok(
      stub.peak > DETAIL_CONCURRENCY,
      `peak in flight was only ${stub.peak}, so this run never approached the bound`,
    );
    assert.ok(
      DETAIL_CONCURRENCY < total,
      'the fixture has fewer launches than the limit, so nothing was bounded',
    );
  });
});

/*
 * ===========================================================================
 * The other half: carrying the gap is worthless if a page does not render it.
 * ===========================================================================
 *
 * Source-read rather than behavioural, because what it checks is a relationship
 * between files and nothing executes it. Five surfaces render these rows and the one
 * failure mode that matters is a SIXTH being added later - the gap would be in the
 * return value, rendered nowhere, and the page would serve a confident subset. That is
 * precisely the silently-truncated board this whole change exists to end, and it would
 * come back by omission rather than by a mistake anyone could see in a diff.
 */

const SRC = new URL('..', import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(`${SRC}${rel}`, 'utf8');
}

/** Every file that calls `loadRows()`, found rather than listed. */
function loadRowsCallers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, 'utf8');
        if (/\bloadRows\s*\(/.test(src) && !p.endsWith('/lib/boardRows.ts')) {
          found.push(p.slice(SRC.length));
        }
      }
    }
  };
  walk(`${SRC}app`);
  return found.sort();
}

test('every page that loads the board also renders the gap', () => {
  const callers = loadRowsCallers();
  /*
   * Anti-vacuity, and it has to be first: a walk that silently found nothing would make
   * every assertion below pass while checking no page at all.
   */
  assert.ok(callers.length >= 4, `found only ${callers.length} callers of loadRows`);
  for (const file of callers) {
    const src = read(file);
    /*
     * The RENDER, not the import. An import line alone satisfies `/UnreadableNotice/`,
     * so a page that stopped rendering the notice but kept the symbol in scope would
     * pass - which is how the first version of the analytics assertion below let an
     * unbounded fan-out through.
     */
    assert.match(
      src,
      /<UnreadableNotice\s+unreadable=/,
      `${file} loads the board and never renders the gap`,
    );
    assert.match(
      src,
      /unreadable\b[^=]*=\s*await loadRows|unreadable[,}][\s\S]{0,80}= await loadRows/,
      `${file} renders the notice without taking \`unreadable\` from the load`,
    );
  }
});

test('the analytics page fans out its own read and must name its own gap', () => {
  /*
   * It does not use `loadRows` - it needs a different row shape - so the walk above
   * cannot see it, and every figure on it is a sum over the rows it got. Named
   * explicitly because a page that builds its own fan-out is exactly the one that would
   * be missed.
   */
  const src = read('app/analytics/page.tsx');
  /*
   * The RENDER and the CALL, not the imports. The first draft of this asserted
   * `/UnreadableNotice/` and `/mapWithConcurrency/`, both of which an import line
   * satisfies on its own - so replacing the bounded fan-out with `Promise.all` left the
   * symbol imported, unused, and the guard green. Rule-52 shaped: a name in scope is not
   * a call.
   */
  assert.match(src, /<UnreadableNotice\s+unreadable=/, 'analytics never renders the gap');
  assert.match(
    src,
    /await\s+mapWithConcurrency</,
    'the analytics fan-out is unbounded again',
  );
});

test('no surface fans out launch details with a bare Promise.all', () => {
  /*
   * The shape of the original defect, in one pattern. `Promise.all` over a mapped list
   * of launches is both failure modes at once: unbounded, and rejecting on the first
   * error. It stays legal for a fixed pair of reads - `[listLaunches(), listQuotes()]`
   * is two requests and both are needed - so this matches a `.map(` inside the call
   * rather than banning the function.
   */
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, 'utf8');
        if (/Promise\.all\(\s*\n?\s*\w*(launches|mine|rows)\w*\s*\n?\s*\.map\(/.test(src)) {
          offenders.push(p.slice(SRC.length));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `an unbounded, first-failure fan-out is back in ${offenders}`);
});
