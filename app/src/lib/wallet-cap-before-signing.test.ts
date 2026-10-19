/**
 * The panel let a buy the curve was certain to refuse be signed, and charged for it.
 *
 * `max_per_wallet` is enforced in `buy`, which returns `WalletCapExceeded` and reverts.
 * `openingBuyOverCap` mirrored that rule for the creator's own opening buy and nothing
 * mirrored it for an ordinary trade: `TradePanel` had no cap check at all, so a capped
 * launch priced the buy, enabled the button, opened the wallet, and the refusal arrived
 * inside the block with the gas already spent. One decision, two places that needed it,
 * made in one - the shape of defect this codebase keeps finding.
 *
 * REPRODUCED ON TESTNET BEFORE ANY OF THIS WAS WRITTEN, at ordinary numbers rather than
 * at extremes. Launch 6 on factory `inj1u350…jtk8`, ticker AUDCAP8, curve
 * `inj1wawzh9dupwdafpwrxnrxdke9l5k8jpgzfzwgcg`:
 *
 *     rules.max_per_wallet                       100000.000000000000000000
 *     PURCHASED[inj1fhqyssaa2hm693v9qtnreu4mcrwvfy6myg742p]
 *                                                 78564.513397317799953997
 *     simulate_buy { inj_in: 0.03 INJ }           47133.185925483433984275
 *                                       total    125697.699322801233938272
 *
 * Every one of those figures came back from the chain. The quote is correct, the curve
 * is right to refuse it, and the only thing signing achieves is a fee.
 *
 * The numbers below are those, kept as the fixture because they are the case the audit
 * walked and because they are nowhere near a boundary - a guard that only bites at
 * cap + 1 would look like it worked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buyOverCap,
  openingBuyOverCap,
  remainingAllowance,
  NO_RULES,
  type LaunchRules,
} from './launchRules.ts';
import { purchasedFromCurve } from './chain.ts';
import { describeBroadcastFailure } from './broadcast.ts';

const SRC = join(import.meta.dirname, '..');
const REPO = join(import.meta.dirname, '..', '..', '..');
const PANEL = readFileSync(join(SRC, 'components', 'TradePanel.tsx'), 'utf8');
/** The contract's own error text, so a rewording there fails here. */
const CURVE_ERRORS = readFileSync(
  join(REPO, 'contracts', 'curve', 'src', 'error.rs'),
  'utf8',
);

const ONE = 10n ** 18n;
/** The measured AUDCAP8 figures, in base units. */
const CAP = 100_000n * ONE;
const HELD = 78_564_513_397_317_799_953_997n;
const QUOTED = 47_133_185_925_483_433_984_275n;

const withCap = (cap: bigint | null): LaunchRules => ({ ...NO_RULES, maxPerWallet: cap });

const CURVE = 'inj1wawzh9dupwdafpwrxnrxdke9l5k8jpgzfzwgcg';
const BUYER = 'inj1fhqyssaa2hm693v9qtnreu4mcrwvfy6myg742p';

test('the measured testnet buy is refused by the resolver the panel now calls', () => {
  assert.equal(buyOverCap(withCap(CAP), HELD, QUOTED), true);
  assert.equal(
    remainingAllowance(withCap(CAP), HELD),
    21_435_486_602_682_200_046_003n,
    'the figure shown to the buyer is cap minus held',
  );
});

test('the boundary is the contract\'s: exactly on the cap is allowed', () => {
  /*
   * `would_exceed_cap` is `held.saturating_add(adding) > cap`, a STRICT `>`. Landing
   * exactly on the cap is a legal buy on chain, so refusing it here would block a trade
   * the curve would have taken - the mirror-image of the defect, and the one nobody
   * reports because the button simply does not work.
   */
  assert.equal(buyOverCap(withCap(100n), 40n, 60n), false, 'the exact boundary was refused');
  assert.equal(buyOverCap(withCap(100n), 40n, 61n), true, 'one unit over was allowed');
  assert.equal(buyOverCap(withCap(100n), 100n, 0n), false);
  assert.equal(buyOverCap(withCap(100n), 101n, 1n), true);
});

test('no cap means no refusal, and a cap of zero is not the same as no cap', () => {
  assert.equal(buyOverCap(withCap(null), 0n, 10n ** 30n), false, 'an absent cap refused a buy');
  assert.equal(buyOverCap(NO_RULES, HELD, QUOTED), false);
  assert.equal(remainingAllowance(withCap(null), HELD), null, 'no cap must say nothing');
  assert.equal(buyOverCap(withCap(0n), 0n, 1n), true, 'a cap of zero stopped nothing');
});

test('an allowance already overrun reads as zero, never as a negative', () => {
  // A creator may set a cap below what a holder already bought. Rendering a minus sign
  // in front of an amount somebody has to act on is worse than saying none is left.
  assert.equal(remainingAllowance(withCap(100n), 250n), 0n);
  assert.equal(remainingAllowance(withCap(CAP), CAP), 0n);
});

test('the opening buy and the trade panel share the one resolver', () => {
  /*
   * ONE COMPARISON. `openingBuyOverCap` is the same rule at held = 0, and the point of
   * routing it through `buyOverCap` is that a change to the boundary cannot be applied
   * to the trade path and forgotten on the create path.
   */
  const rules = readFileSync(join(SRC, 'lib', 'launchRules.ts'), 'utf8');
  assert.match(
    rules,
    /export function openingBuyOverCap\([^)]*\)[^{]*\{\s*return buyOverCap\(rules, 0n, tokensOut\);/,
    'openingBuyOverCap computes the cap itself instead of delegating',
  );
  for (const tokens of [0n, 1n, CAP, CAP + 1n, QUOTED]) {
    assert.equal(openingBuyOverCap(withCap(CAP), tokens), buyOverCap(withCap(CAP), 0n, tokens));
  }
});

test('the trade panel reads the allowance from the chain and decides with the resolver', () => {
  assert.match(PANEL, /purchasedFromCurve\(/, 'the panel never reads the wallet allowance');
  assert.match(PANEL, /buyOverCap\(rules, purchased, quote\.tokensOut\)/, 'the panel decides the cap itself');
  assert.match(
    PANEL,
    /disabled=\{[^}]*overCap === true/,
    'the Buy button is not disabled on an over-cap quote',
  );
  /*
   * AND NOT ON AN UNREAD ALLOWANCE. `overCap` is `boolean | null` so the three outcomes
   * stay distinct, and `=== true` is what keeps `null` out of the disable. A truthiness
   * test would read the same and stop a legitimate trade whenever our own read failed.
   */
  assert.doesNotMatch(
    PANEL,
    /disabled=\{[^}]*\|\|\s*overCap\s*[}]/,
    'overCap is tested for truthiness, so a failed read disables a legitimate buy',
  );
  assert.match(
    PANEL,
    /purchased === null\s*\?\s*null/,
    'an unread allowance does not resolve to its own outcome',
  );
  /*
   * THE CAP IS NOT A TOKEN BALANCE and the panel already holds one. `PURCHASED` counts
   * buys minus sells through the curve: tokens received as a transfer are not capped and
   * tokens sold free the allowance, so `tokenBal` is a different quantity that happens
   * to be close on a fresh wallet. Substituting it would pass every manual check.
   */
  assert.doesNotMatch(
    PANEL,
    /buyOverCap\([^)]*tokenBal/,
    'the wallet cap is being checked against a token balance',
  );
});

test('the allowance is re-read after a trade settles, not left as it was', () => {
  /*
   * Both a buy and a sell move it, and `router.refresh()` cannot: the allowance is read
   * in this client component, not server-rendered. Without this, two buys that each fit
   * and together do not would both be offered.
   */
  assert.match(PANEL, /setSettled\(\(n\) => n \+ 1\)/, 'nothing re-reads after a confirmation');
  assert.match(PANEL, /\}, \[account, capped, curve, settled\]\)/, 'the allowance read ignores it');
});

test('the allowance is only read when a cap exists and the curve is still live', () => {
  // The rule expires at graduation, so on the pool the answer cannot change anything
  // and the request is pure cost on a page that already issues plenty.
  assert.match(PANEL, /const capped = rules\.maxPerWallet !== null && !inPool;/);
});

/* ------------------------------------------------------------------ *
 * The read itself. Three outcomes, and the key layout.
 * ------------------------------------------------------------------ */

/**
 * The LCD's raw-state endpoint, modelled on the live one.
 *
 * The key is checked rather than assumed: this is the exact byte string measured on the
 * running testnet, listed out of that contract's `/state` dump. cw-storage-plus stores
 * a `Map` entry at `len(ns) as u16 BE || ns || key`, and an `Addr` key is its bech32
 * text, so one wrong assumption about either produces a DIFFERENT, uninitialised key
 * that answers `{"data": null}` - a plausible zero from the wrong place, which is the
 * failure mode the Sealed notes record for a wrong Uniswap pool id.
 */
const MEASURED_KEY_HEX =
  '0009707572636861736564' +
  Buffer.from(BUYER).toString('hex');

function stubRaw(respond: (keyHex: string) => Response) {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const seg = String(url).split('/raw/')[1];
    const keyHex = Buffer.from(decodeURIComponent(seg), 'base64').toString('hex');
    seen.push(keyHex);
    return respond(keyHex);
  }) as unknown as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

async function withRaw<T>(
  respond: (keyHex: string) => Response,
  fn: (seen: string[]) => Promise<T>,
): Promise<T> {
  const prevDemo = process.env.NEXT_PUBLIC_DEMO;
  process.env.NEXT_PUBLIC_DEMO = '';
  const stub = stubRaw(respond);
  try {
    return await fn(stub.seen);
  } finally {
    stub.restore();
    process.env.NEXT_PUBLIC_DEMO = prevDemo;
  }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('the raw key is the one measured on chain', async () => {
  await withRaw(() => ok({ data: null }), async (seen) => {
    await purchasedFromCurve(CURVE, BUYER);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0],
      MEASURED_KEY_HEX,
      'the key does not address the entry the chain holds, so every answer is a zero from the wrong place',
    );
  });
});

test('a value the chain holds is parsed, including the quotes a Uint128 is stored with', async () => {
  const stored = Buffer.from(`"${HELD}"`).toString('base64');
  await withRaw(() => ok({ data: stored }), async () => {
    assert.equal(await purchasedFromCurve(CURVE, BUYER), HELD);
  });
});

test('no entry is a measured zero; a read that failed is not', async () => {
  // `{"data": null}` at a 200 is the chain saying there is no entry, which the contract
  // itself reads with `unwrap_or_default`. That is a real zero.
  await withRaw(() => ok({ data: null }), async () => {
    assert.equal(await purchasedFromCurve(CURVE, BUYER), 0n);
  });
  /*
   * EVERYTHING ELSE IS `null`, because zero is the dangerous answer here: it reads as a
   * full allowance and would re-enable the exact buy this exists to stop. A 200 with the
   * wrong body is included on purpose - a 200 is not a success.
   */
  for (const [label, respond] of [
    ['a 500', () => new Response('nope', { status: 500 })],
    ['a 404', () => new Response('nope', { status: 404 })],
    ['html at a 200', () => new Response('<!doctype html>', { status: 200 })],
    ['a number instead of base64', () => ok({ data: 7 })],
    ['base64 of something else', () => ok({ data: Buffer.from('{"held":"1"}').toString('base64') })],
    ['no data field at all', () => ok({})],
  ] as const) {
    await withRaw(respond, async () => {
      const v = await purchasedFromCurve(CURVE, BUYER);
      assert.equal(v === null || v === 0n, true);
      assert.notEqual(v, 0n, `${label} resolved to a full allowance`);
    });
  }
});

test('a fetch that throws is not read as zero either', async () => {
  const real = globalThis.fetch;
  const prevDemo = process.env.NEXT_PUBLIC_DEMO;
  process.env.NEXT_PUBLIC_DEMO = '';
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  try {
    assert.equal(await purchasedFromCurve(CURVE, BUYER), null);
  } finally {
    globalThis.fetch = real;
    process.env.NEXT_PUBLIC_DEMO = prevDemo;
  }
});

/* ------------------------------------------------------------------ *
 * The refusal, when one still arrives.
 * ------------------------------------------------------------------ */

/** The contract's own rendering of an error, with its placeholders filled in. */
function curveError(variant: string, values: Record<string, string>): string {
  const re = new RegExp(`#\\[error\\("([^"]+)"\\)\\]\\s*${variant}\\b`);
  const m = re.exec(CURVE_ERRORS);
  assert.ok(m, `no #[error] attribute for ${variant} in contracts/curve/src/error.rs`);
  let text = m[1];
  for (const [k, v] of Object.entries(values)) text = text.split(`{${k}}`).join(v);
  assert.doesNotMatch(text, /\{[a-z_]+\}/, `${variant} has a placeholder this test did not fill: ${text}`);
  return text;
}

const GENERIC = describeBroadcastFailure('something nobody wrote a branch for');

test('the curve\'s own refusals are translated, not reported as the chain rejecting the transaction', () => {
  /*
   * Each string is built from the contract's `#[error]` attribute, so rewording one in
   * Rust fails this test rather than silently falling through to the generic sentence.
   * "The chain refused the transaction" over a correct, deliberate contract rule reads
   * to a trader as the app being broken.
   */
  const cases: Array<[string, string, Record<string, string>]> = [
    ['the wallet cap', 'WalletCapExceeded', { cap: String(CAP), held: String(HELD), adding: String(QUOTED) }],
    ['the slippage bound', 'Slippage', { got: '100', min: '200' }],
    ['a launch not open yet', 'NotOpenYet', { start: '1792412340000000000', now: '1792412000000000000' }],
  ];
  for (const [label, variant, values] of cases) {
    const raw = curveError(variant, values);
    const out = describeBroadcastFailure(raw);
    assert.notEqual(out, GENERIC, `${label} fell through to the generic refusal: ${raw}`);
    assert.doesNotMatch(out, /\d{15}/, `${label} shows a raw base-unit figure to the user`);
  }
});

test('the slippage branch matches the message the contract actually sends', () => {
  /*
   * IT DID NOT, AND HAD NEVER. The branch looked for the word "slippage";
   * `ContractError::Slippage` renders as "would receive G but asked for at least M" and
   * never contains it. The contracts' own integration test records making this exact
   * mistake and was fixed to assert "asked for at least"; the lesson stayed in the Rust.
   * So the refusal a trader is most likely to hit read as the chain rejecting them.
   */
  const raw = curveError('Slippage', { got: '1000', min: '2000' });
  assert.doesNotMatch(raw, /slippage/i, 'the contract message now says slippage, so this guard is moot');
  assert.match(describeBroadcastFailure(raw), /slippage tolerance/);
});

test('the cap refusal names what is left, which is the only actionable part', () => {
  const raw = curveError('WalletCapExceeded', {
    cap: String(CAP),
    held: String(HELD),
    adding: String(QUOTED),
  });
  const out = describeBroadcastFailure(raw);
  assert.match(out, /100000/, 'the cap is not named');
  assert.match(out, /21435\.4866/, 'the remaining allowance is not named');
  assert.match(out, /Selling frees the allowance again/);
});
