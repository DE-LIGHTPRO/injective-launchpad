/**
 * The launch page must not say a launch has never traded when its curve says it has.
 *
 * MEASURED ON THE LIVE TESTNET, 17 Oct 2026. All four launches on factory
 * inj1u350rygnvuxyzqcwzz6wulu4q70te4ez3hjtk8 answered the trade search with HTTP 500
 * `height N is not available, lowest height is M` - ordinary pruning, the sentry keeps
 * about 100,000 blocks. Two of the four have traded: one with 495,558 tokens sold and
 * one graduated with the whole 800,000,000 curve supply sold. The page nonetheless
 * rendered, for both of them, a disabled Market tab titled "No trades yet" and a trade
 * card ending "This says nothing about whether the launch has traded".
 *
 * ONE SOURCE, ONE ANSWER - the shape this codebase keeps finding. Trade history comes
 * from the chain's transaction search and nowhere else, and from there a pruned launch
 * is indistinguishable from an untraded one. The page already holds the contract's own
 * state, from a smart query that SUCCEEDED on the same render, and that state settles
 * it for free. `hasEverTraded` is the one resolver; both surfaces are passed its
 * verdict rather than each deriving one from whatever it happens to hold.
 *
 * Why this matters past cosmetics: "nothing has traded yet" on a graduated launch is a
 * claim about the market, on the page where somebody decides whether to buy, made from
 * a read that failed. On mainnet the retention window is about sixteen hours, so this
 * is the normal state of every launch older than a day rather than an edge case.
 *
 * The behavioural half drives `loadTradeView` against a stubbed LCD, because the whole
 * defect was a caller satisfying every signature while contradicting the purpose. The
 * source half pins the four sentences, each matched together with the condition that
 * selects it: a guard cannot see reachability, so a claim and its guard have to be ONE
 * expression or replacing the condition with a constant leaves both strings in place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasEverTraded, loadTradeView } from './tradeView.ts';
import type { LaunchDetail } from './chain.ts';

const SRC = join(import.meta.dirname, '..');

function read(rel: string): string {
  const src = readFileSync(join(SRC, rel), 'utf8');
  assert.ok(src.length > 500, `${rel} read as ${src.length} bytes; this guard is pointed at nothing`);
  return src;
}

type Evidence = Pick<
  LaunchDetail,
  'state' | 'platformOwed' | 'creatorOwed' | 'platformPaid' | 'creatorPaid'
>;

/** A launch that exists and has done nothing. Every counter at its genesis value. */
const FRESH: Evidence = {
  state: { injCollected: 0n, tokensSold: 0n, graduated: false },
  platformOwed: 0n,
  creatorOwed: 0n,
  platformPaid: 0n,
  creatorPaid: 0n,
};

test('a fresh launch has not traded, which is what makes the untraded copy honest', () => {
  assert.equal(hasEverTraded(FRESH), false);
});

test('a graduated launch has traded, however its counters read', () => {
  assert.equal(hasEverTraded({ ...FRESH, state: { ...FRESH.state, graduated: true } }), true);
});

test('tokens sold or quote collected is enough on its own', () => {
  assert.equal(
    hasEverTraded({ ...FRESH, state: { ...FRESH.state, tokensSold: 1n } }),
    true,
    '495558831487511546105114 sold was the live case; one base unit is the same fact',
  );
  assert.equal(hasEverTraded({ ...FRESH, state: { ...FRESH.state, injCollected: 1n } }), true);
});

test('a buyer who sold out completely is still a trade, because the fee counters do not reverse', () => {
  /*
   * THE REASON THIS TAKES THE DETAIL RATHER THAN THE CURVE STATE. `tokensSold` and
   * `injCollected` both go back DOWN on a sell and return to zero when the only buyer
   * sells out, so a resolver reading those alone would call a traded launch untraded
   * at exactly the moment its history matters most. A fee accrues on the first buy and
   * `owed + paid` never decreases, so that is the durable half of the evidence.
   */
  for (const field of ['platformOwed', 'creatorOwed', 'platformPaid', 'creatorPaid'] as const) {
    assert.equal(hasEverTraded({ ...FRESH, [field]: 1n }), true, `${field} alone proves a trade`);
  }
});

/**
 * Stand in for the LCD, then put the real `fetch` back.
 *
 * The reply sees the URL because `loadTradeView` makes two different requests: the tx
 * search, and the current height afterwards. A stub answering every request the same
 * way cannot express the case where the first fails.
 */
async function withLcd<T>(reply: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(
      reply(String(typeof input === 'object' && 'url' in input ? input.url : input)),
    )) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const QUOTE = { denom: 'inj', label: 'INJ', decimals: 18 } as const;

/** The real body this chain returns for a launch older than the answering node keeps. */
const PRUNED = {
  code: 13,
  message: 'height 143413049 is not available, lowest height is 144058255',
};

test('the verdict survives a trade search that failed', async () => {
  const result = await withLcd(
    (url) => (url.includes('/cosmos/tx/') ? json(PRUNED, 500) : json({}, 500)),
    () =>
      loadTradeView({
        curve: 'inj1sfsycn5pak9t7ap0h97c25vumz6w0ewag2xc4x',
        denom: 'factory/inj1x/seal',
        quote: QUOTE,
        tradedOnChain: true,
      }),
  );
  assert.equal(result.kind, 'error', 'a pruned 500 is still an error, and must stay one');
  assert.equal(
    result.kind === 'error' && result.tradedOnChain,
    true,
    'the curve knew this launch had traded and the failed read dropped the answer',
  );
});

test('the verdict survives a trade search that succeeded and returned nothing', async () => {
  const result = await withLcd(
    (url) =>
      url.includes('/cosmos/tx/')
        ? json({ tx_responses: [], txs: [], total: '0' })
        : json({ block: { header: { height: '144158265' } } }),
    () =>
      loadTradeView({
        curve: 'inj1sfsycn5pak9t7ap0h97c25vumz6w0ewag2xc4x',
        denom: 'factory/inj1x/seal',
        quote: QUOTE,
        tradedOnChain: true,
      }),
  );
  assert.equal(result.kind, 'view');
  assert.equal(result.kind === 'view' && result.view.trades.length, 0);
  assert.equal(
    result.kind === 'view' && result.tradedOnChain,
    true,
    'an empty 200 from a node whose index starts after the launch is not an untraded launch',
  );
});

test('the chart tooltip separates no data from no trades', () => {
  const src = read(join('components', 'PriceChart.tsx'));
  /*
   * Matched as one expression. The tab is disabled on `!hasTrades`, which is about the
   * SERIES; the sentence is about the LAUNCH, and only `tradedOnChain` knows that.
   */
  assert.match(
    src,
    /tradedOnChain\s*\n?\s*\?\s*'No fill history could be read for this launch'\s*\n?\s*:\s*'No trades yet'/,
    'the disabled Market tab must say why it is empty, and "No trades yet" is only one of the two reasons',
  );
});

test('the empty chart states which absence it is', () => {
  const src = read(join('components', 'PriceChart.tsx'));
  assert.match(
    src,
    /tradedOnChain\s*\n?\s*\?\s*'This launch has traded[^']*'\s*\n?\s*:\s*'Nothing has traded yet, so there is no price history to draw\.'/,
    'the untraded sentence must be the false branch of the curve verdict, not the only branch',
  );
});

test('the trade card reports a failed read as a failed read, and only then', () => {
  const src = read(join('components', 'Trades.tsx'));
  const guarded = src.indexOf("result.kind === 'error' && result.tradedOnChain");
  const bare = src.indexOf("if (result.kind === 'error') {");
  assert.ok(guarded > 0, 'the error branch no longer splits on whether the launch has traded');
  assert.ok(bare > 0, 'the plain error branch is gone, so a failed read has nowhere to go');
  /*
   * ORDER IS THE BEHAVIOUR here, and no string match can see it. The guarded branch
   * second is unreachable: every error would take the untraded copy, including a
   * graduated launch, which is the defect inverted rather than fixed.
   */
  assert.ok(
    guarded < bare,
    'the traded branch must come first; after the plain one it can never be reached',
  );
  /*
   * And the condition has to END there, matched together with its consequence as one
   * expression. Ordering alone passed a mutant that appended `&& false`: both branches
   * still present, both strings still in the file, the first permanently unreachable.
   * A source guard cannot see reachability, so it has to see the whole condition.
   */
  assert.match(
    src,
    /if \(result\.kind === 'error' && result\.tradedOnChain\)\s*\{[\s\S]*?The curve&rsquo;s own state says this launch has traded/,
    'the traded error branch must be selected by that condition and nothing added to it',
  );
});

test('the trade card does not call an unreadable launch untraded', () => {
  const src = read(join('components', 'Trades.tsx'));
  assert.match(
    src,
    /result\.tradedOnChain\s*\n?\s*\?\s*'The curve reports trades[^']*'\s*\n?\s*:\s*'Nothing yet\. The first buy will appear here within a block\.'/,
    'an empty result and an untraded launch must not render the same sentence',
  );
});

test('the page resolves the verdict once and hands it to both surfaces', () => {
  /*
   * Rule 52 of the Sealed file, which this project keeps re-learning: registration is
   * not wiring. A resolver both surfaces accept and nobody passes leaves every claim
   * exactly as wrong as it was, with tests that pass.
   */
  const src = read(join('app', 'launch', '[slug]', 'page.tsx'));
  assert.match(src, /const tradedOnChain = hasEverTraded\(detail\)/);
  assert.match(
    src,
    /loadTradeView\(\{[\s\S]*?tradedOnChain,[\s\S]*?\}\)/,
    'the trade list reads the verdict off the result, so the loader has to be given it',
  );
  assert.match(
    src,
    /<PriceChart[\s\S]*?tradedOnChain=\{tradedOnChain\}/,
    'the chart is the surface that made the claim in the largest type',
  );
});
