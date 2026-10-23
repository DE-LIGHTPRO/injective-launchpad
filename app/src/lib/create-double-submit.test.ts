/**
 * THE SAME LAUNCH WAS SENT TWICE, and the second one could only ever burn gas.
 *
 * Audit F-05, measured on testnet: block 143426568 created `ghdsjs`, and eight
 * seconds later block 143426582 ran the same `create_launch` and failed. The
 * re-entry guard was never the problem - `busy` is set before the signature is
 * requested and every path goes through it - the problem is that `setBusy(false)` in
 * the `finally` re-ARMED the button over a form that still said `ghdsjs`. A creator
 * who does not yet see a new row, because the refresh has not landed, presses the
 * only button on the screen again. The denom already exists, so the chain refuses
 * the whole transaction, and what the creator sees for their gas is an error.
 *
 * Two guards, because neither covers the other's case:
 *
 *  - A SESSION LATCH on the ticker that landed. Covers the eight-second re-submit
 *    exactly, needs no network, and cannot be wrong. Keyed on the symbol rather than
 *    a bare boolean because launching a second, different token is legitimate.
 *  - A CHAIN READ of the denoms this wallet has already created. Covers a reload, a
 *    second tab, and a ticker used days ago, none of which the latch can see.
 *
 * THE CHAIN READ HAD TO BE MEASURED BEFORE IT COULD BE CHOSEN, and the obvious
 * endpoint cannot answer the question. `/injective/tokenfactory/v1beta1/
 * denoms/{denom}/authority_metadata` on testnet, 23 Oct 2026:
 *
 *     factory/inj1fhq…742p/AUDLAB7               200  {"admin":"inj13n7z…3llk"}
 *     factory/inj1fhq…742p/NOPETHISDOESNOTEXIST  200  {"admin":""}
 *     factory/inj1u35…tk8/AUDLAB7                200  {"admin":""}
 *
 * A denom nobody ever created and one whose admin was cleared are the same 200 with
 * the same body, so existence read off that route is a 200 taken for an answer.
 * `denoms_from_creator` answers it directly and distinguishes empty from populated.
 *
 * These drive the real `denomsFromCreator` through a stubbed LCD, because what is
 * under test is which answers it will and will not turn into a verdict - a fixture of
 * one response cannot exercise that - plus source guards on `CreateLaunch`, since the
 * wiring is the half rule 52 keeps catching: a correct helper nothing reaches.
 *
 * F-10 rides along here because it is the same block of the same file and turns on the
 * same evidence. The Create page told every visitor "This signing path has not yet
 * been run against a chain" while the audit's F-05 finding IS two create transactions
 * in testnet blocks. A caution that has stopped being true costs what a missing one
 * costs, because the next true caution reads like this one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { denomsFromCreator } from './chain.ts';
import { denomFor, tickerAlreadyUsed } from './createLaunch.ts';
import { maskComments } from './testing/maskComments.ts';

const CREATOR = 'inj1fhqyssaa2hm693v9qtnreu4mcrwvfy6myg742p';
const PANEL = readFileSync(new URL('../components/CreateLaunch.tsx', import.meta.url), 'utf8');

/** Every URL the call under test asked for, so the request can be asserted too. */
interface Stub {
  urls: string[];
  restore: () => void;
}

function stubLcd(status: number, body: unknown | (() => never)): Stub {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (typeof body === 'function') (body as () => never)();
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}

test('a populated answer is the list of denoms this creator has made', async () => {
  const s = stubLcd(200, {
    denoms: [`factory/${CREATOR}/AUDLAB7`, `factory/${CREATOR}/ghdsjs`],
  });
  try {
    assert.deepEqual(await denomsFromCreator(CREATOR), [
      `factory/${CREATOR}/AUDLAB7`,
      `factory/${CREATOR}/ghdsjs`,
    ]);
    /*
     * The route, and that it carries no pagination parameter. `denoms_from_creator`
     * accepts none, so there is no prefix to mistake for the whole list - and if a
     * limit were added later it would turn a complete answer into one, which is the
     * truncation defect `balance-paging` exists for.
     */
    assert.equal(s.urls.length, 1);
    assert.match(s.urls[0], /\/injective\/tokenfactory\/v1beta1\/denoms_from_creator\//);
    assert.ok(s.urls[0].endsWith(CREATOR), 'the creator is not the last path segment');
    assert.ok(!s.urls[0].includes('pagination'), 'a page size turns a full answer into a prefix');
  } finally {
    s.restore();
  }
});

test('a creator who has made nothing answers with an empty list, not an unread one', async () => {
  const s = stubLcd(200, { denoms: [] });
  try {
    assert.deepEqual(await denomsFromCreator(CREATOR), []);
  } finally {
    s.restore();
  }
});

test('a 200 whose shape is not recognised is unread, never an empty list', async () => {
  /*
   * THE RULE 45 CASE, and the direction matters. `[]` means "this wallet has created
   * nothing", which makes a taken ticker look free and re-opens the exact submit this
   * guard exists to close. `null` means "not read", which neither blocks nor
   * reassures. A body the code does not recognise has to be the second one.
   */
  for (const body of [{}, { denoms: null }, { denoms: 'factory/x/Y' }, { denoms: { 0: 'x' } }, []]) {
    const s = stubLcd(200, body);
    try {
      assert.equal(
        await denomsFromCreator(CREATOR),
        null,
        `${JSON.stringify(body)} was turned into a verdict`,
      );
    } finally {
      s.restore();
    }
  }
});

test('a non-string entry is dropped rather than compared as one', async () => {
  const s = stubLcd(200, { denoms: [`factory/${CREATOR}/A`, 7, null, `factory/${CREATOR}/B`] });
  try {
    assert.deepEqual(await denomsFromCreator(CREATOR), [
      `factory/${CREATOR}/A`,
      `factory/${CREATOR}/B`,
    ]);
  } finally {
    s.restore();
  }
});

test('an unreachable or refusing node is unread, not a free ticker', async () => {
  for (const status of [400, 404, 500, 501, 503]) {
    const s = stubLcd(status, { code: 3, message: 'invalid address' });
    try {
      assert.equal(await denomsFromCreator(CREATOR), null, `${status} was turned into a verdict`);
    } finally {
      s.restore();
    }
  }
  const thrown = stubLcd(200, () => {
    throw new TypeError('fetch failed');
  });
  try {
    assert.equal(await denomsFromCreator(CREATOR), null, 'a thrown request was turned into a verdict');
  } finally {
    thrown.restore();
  }
});

test('a tokenfactory denom is case sensitive, so the comparison is on the exact string', () => {
  /*
   * `factory/<creator>/<subdenom>` is compared byte for byte by the chain, and the
   * ticker input preserves case. `GHDSJS` and `ghdsjs` are two denoms and the chain
   * will create the second after the first, so a case-folded comparison would refuse
   * a launch that is legitimate - the failure direction the whole pre-check avoids.
   */
  const mine = [denomFor(CREATOR, 'ghdsjs')];
  assert.equal(tickerAlreadyUsed(mine, CREATOR, 'ghdsjs'), true, 'the taken ticker is not recognised');
  assert.equal(tickerAlreadyUsed(mine, CREATOR, 'GHDSJS'), false, 'a different denom reads as taken');
  /* And the trim the form applies, so a pasted ticker is compared as it will be sent. */
  assert.equal(tickerAlreadyUsed(mine, CREATOR, '  ghdsjs '), true, 'surrounding space is compared');
});

test('an unread list, an absent wallet and an empty ticker are all "not read"', () => {
  /*
   * Three distinct reasons there is nothing to compare, and all three must answer
   * `null` rather than `false`. `false` is a claim that the name is free, and it would
   * reach the screen as a button that looks checked and is not.
   */
  assert.equal(tickerAlreadyUsed(null, CREATOR, 'ghdsjs'), null, 'an unread list became a verdict');
  assert.equal(tickerAlreadyUsed([], null, 'ghdsjs'), null, 'no wallet became a verdict');
  assert.equal(tickerAlreadyUsed([], CREATOR, '   '), null, 'an empty ticker became a verdict');
  /* A creator who has genuinely made nothing is a measured `false`, not an unread one. */
  assert.equal(tickerAlreadyUsed([], CREATOR, 'ghdsjs'), false, 'a free ticker reads as unread');
  /* Another wallet's denom of the same name does not block this one. */
  assert.equal(
    tickerAlreadyUsed([denomFor('inj1someoneelse', 'ghdsjs')], CREATOR, 'ghdsjs'),
    false,
    'a ticker taken by a different creator blocks this wallet',
  );
});

test('the create button is closed by both guards and opened by neither being unread', () => {
  const src = maskComments(PANEL);

  /* Rule 52: the read exists and something reaches it. */
  assert.match(src, /denomsFromCreator\(account\.address\)/, 'nothing reads the creator\u2019s denoms');

  /*
   * The latch is set from the ticker that LANDED, inside the branch that knows it
   * landed. Setting it on the signature would latch a refused launch and leave the
   * creator unable to retry their own failed transaction.
   */
  assert.match(
    src,
    /if\s*\(landed\)\s*\{[\s\S]{0,200}?setCreatedSymbol\(f\.symbol\.trim\(\)\)/,
    'the session latch is not set from the ticker that landed',
  );

  /*
   * `=== true`, not truthiness. `tickerAlreadyUsed` answers `null` for an unread list,
   * and an unread list must not disable the only button on the page. Asserted on the
   * source because the behaviour is a tri-state collapsing to a boolean, and `null`
   * and `false` are already indistinguishable to a `||`.
   */
  assert.match(src, /tickerAlreadyUsed\(mine,/, 'the panel compares denoms itself again');
  assert.match(src, /tickerTaken\s*===\s*true/, 'an unread denom list can block a launch');
  assert.match(
    src,
    /const\s+alreadyLaunched\s*=[\s\S]{0,200}?createdSymbol\s*===\s*f\.symbol\.trim\(\)/,
    'the two reasons are not one decision, so a path can forget the chain read',
  );

  /* One disable, carrying both, beside the affordability gate that was already there. */
  assert.match(
    src,
    /disabled=\{![\s\S]{0,120}?alreadyLaunched\}/,
    'the button is still armed over a launch that already exists',
  );

  /* And a reason on screen: a dead button with no explanation reads as a broken page. */
  assert.match(src, /already created \$\{f\.symbol\.trim\(\)\}/, 'the chain-read refusal is unexplained');
  assert.match(src, /was just created from this wallet/, 'the session-latch refusal is unexplained');
});

test('the create page no longer claims the signing path has never run', () => {
  const src = maskComments(PANEL);
  assert.ok(
    !/signing path has not yet been run/.test(src),
    'the stale caution is back, and the audit found it after two create transactions landed',
  );
  /*
   * Scoped by the network the build points at, not by a flag somebody has to clear.
   * Mainnet genuinely has not been exercised, so the caution is true there and the
   * scope is what keeps it true as that changes.
   */
  assert.match(
    src,
    /NETWORK\.name === 'mainnet'[\s\S]{0,200}?exercised on testnet and not yet on mainnet/,
    'the remaining caution is not scoped to the network that has not been exercised',
  );
  /* The structural reassurance was the honest half and survives on both branches. */
  assert.equal(
    src.match(/All five messages go in a single transaction/g)?.length,
    2,
    'one branch of the caution dropped what actually makes a mis-built launch safe',
  );
});
