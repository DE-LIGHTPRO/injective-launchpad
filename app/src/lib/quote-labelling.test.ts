import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { fixedCurveFor, graduationWholeFor, openingReserveWholeFor } from './launchLimits.ts';
import { rowQuoteLabel, type LaunchRow } from './launchList.ts';

/**
 * Is a launch's money labelled with the launch's own quote?
 *
 * THE DEFECT THIS EXISTS FOR. Every money figure on the board and the launch page
 * was rendered with `NETWORK.quoteSymbol` and scaled with a literal 18, which was
 * correct for exactly as long as every launch was priced in INJ. Adding a second
 * quote asset made all of them wrong at once: Injective's USDC is 6 decimals, so a
 * USDC-paired launch rendered amounts a trillion times too large under the ticker of
 * an asset it was not in.
 *
 * That is not an approximation, it is a different number wearing the wrong name, and
 * nothing about it looks wrong on screen. No runtime test catches it either, because
 * with one quote allowlisted the default is also the right answer and every
 * assertion passes.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * Components that render figures belonging to a SPECIFIC launch.
 *
 * Not every use of the default is a defect: a page describing the launchpad, a
 * wallet prompt, or the curve explorer's hypothetical launch are all about the
 * platform, where the network's own quote is the correct and only answer. The list
 * is the surfaces showing money that some particular curve holds.
 */
const PER_LAUNCH = [
  'components/Portfolio.tsx',
  'components/FeeEarnings.tsx',
  'components/TradePanel.tsx',
  'components/Trades.tsx',
  'components/LaunchList.tsx',
  'components/KingOfTheHill.tsx',
  'components/CurveChart.tsx',
  'components/PairPanels.tsx',
  /*
   * THE LIST WENT STALE AND THIS IS THE FILE THAT PROVED IT. `LaunchPreview` renders a
   * creator's opening buy against the selected pair's ticker, which is a per-launch
   * money figure by any reading, and it was never added - so none of the guards below
   * looked at it. It would not have been caught anyway: it uses neither
   * `NETWORK.quoteSymbol` nor a hardcoded ticker, which are the two spellings the text
   * guards know. Only the arithmetic assertion further down binds it.
   */
  'components/LaunchPreview.tsx',
  'app/launch/[slug]/page.tsx',
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/[^\n]*/g, '');
}

test('no per-launch figure is labelled with the network default quote', () => {
  const offenders: string[] = [];
  for (const rel of PER_LAUNCH) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    for (const m of src.matchAll(/NETWORK\.quote(Symbol|Decimals|Denom)/g)) {
      offenders.push(`${rel}: NETWORK.quote${m[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a launch's own amounts are being rendered in the network's default quote",
  );
});

test('gas is a separate concept from the default quote', () => {
  /*
   * `NETWORK.quoteDenom` was doing double duty as "the default quote" and "what gas
   * is paid in". They are the same denom on Injective, so code reserving gas reached
   * for `quoteDenom` and was right by luck, and the guard above could not tell that
   * use from a launch's amounts being mislabelled.
   *
   * Separating them is better than exempting the call: the code now says which it
   * means, and the guard stays strict instead of growing a hole that the next
   * genuine defect would fit through.
   */
  const cfg = readFileSync(join(SRC, 'lib/config.ts'), 'utf8');
  assert.match(cfg, /gasDenom:\s*string/, 'gas has no name of its own');
  const panel = readFileSync(join(SRC, 'components/TradePanel.tsx'), 'utf8');
  assert.ok(
    !/gasReserveFor\([^)]*quoteDenom\)/.test(panel),
    'the gas reserve is reading the default quote again',
  );

  /*
   * AND THE SPLIT STOPPED ONE FIELD SHORT, which is this half. `gasDenom` got its own
   * name; `gasSymbol` and `gasDecimals` did not, so every figure in the create form's
   * cost row - Injective's denom-creation fee, the gas reserve, the wallet's balance,
   * all of them read in `gasDenom` - was scaled by `quoteDecimals` and labelled
   * `quoteSymbol`. The denom being read and the scale being applied came from two
   * different fields.
   *
   * Right by coincidence today, since `inj` is both. Pointing a deployment's default
   * quote at a 6-decimal asset would have printed the denom fee off by 10^12 in the one
   * place a creator checks what signing costs, and the guard above could not see it:
   * `CreateLaunch` is not a per-launch surface, so `NETWORK.quote*` there is legitimate
   * for the quote and was indistinguishable from this.
   */
  assert.match(cfg, /gasSymbol:\s*string/, 'the gas asset has no ticker of its own');
  assert.match(cfg, /gasDecimals:\s*number/, 'the gas asset has no scale of its own');
});

test('a gas-denominated figure is scaled and labelled as the gas asset', () => {
  /*
   * The half the config assertion cannot see: declaring the fields and still passing
   * `NETWORK.quoteDecimals` typechecks and reads correctly on Injective.
   *
   * Found by walking the tree rather than naming `CreateLaunch.tsx`, because a second
   * surface stating a cost is exactly the case a named list misses - the per-launch
   * list in this same file has already gone stale once, and says so.
   */
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(
      /\b(?:cost\.\w+|gasBalance[\w ?.]*)\s*,\s*NETWORK\.quote(Symbol|Decimals)/g,
    )) {
      offenders.push(`${file.slice(SRC.length + 1)}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, [], 'a gas-asset amount is being scaled by the default quote');

  /*
   * Anti-vacuity, and the assertion that actually binds. The pattern above matches
   * nothing once the defect is fixed, so on its own it would pass just as happily
   * against a cost row that had been deleted. This requires the row to still be
   * rendering the total, in the gas asset.
   */
  const form = stripComments(readFileSync(join(SRC, 'components/CreateLaunch.tsx'), 'utf8'));
  const required: Array<[RegExp, string]> = [
    [
      /fmt\(cost\.total,\s*NETWORK\.gasDecimals[\s\S]{0,40}?NETWORK\.gasSymbol/,
      'the create form no longer states the total cost in the gas asset, scale and ticker together',
    ],
    [
      /fmt\(cost\.denomFee,\s*NETWORK\.gasDecimals/,
      'the denom-creation fee is not scaled as the gas asset it is paid in',
    ],
    [
      /fmt\(gasBalance \?\? 0n,\s*NETWORK\.gasDecimals/,
      'the wallet balance the refusal quotes is not scaled as the gas asset it was read in',
    ],
  ];
  for (const [pattern, why] of required) {
    // Not `assert.match`: its failure dumps the whole 40KB component into the output.
    assert.ok(pattern.test(form), why);
  }
});

test('the per-launch list still covers the components that exist', () => {
  /*
   * A guard listing files by name goes stale silently: a component renamed or split
   * leaves the list passing while the new file is unchecked. This fails instead.
   */
  for (const rel of PER_LAUNCH) {
    assert.doesNotThrow(
      () => readFileSync(join(SRC, rel), 'utf8'),
      `${rel} is in the per-launch list and does not exist`,
    );
  }
});

test('every component rendering money takes a quote to render it in', () => {
  /*
   * The positive half. Passing the two halves of a quote as separate props is how
   * one gets missed, so they travel as one object and a component either has it or
   * does not.
   */
  const needsQuote = ['components/FeeEarnings.tsx', 'components/TradePanel.tsx', 'components/Trades.tsx'];
  for (const rel of needsQuote) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    assert.ok(
      /quote(Asset)?:\s*Quote/.test(src),
      `${rel} renders amounts and does not accept a Quote`,
    );
  }
});

test('no per-launch surface hardcodes a ticker as a literal', () => {
  /*
   * THE SPELLING THE FIRST VERSION MISSED. This guard looked for
   * `NETWORK.quoteSymbol`, and `CurveChart` did not use it: its axis read the bare
   * string "INJ", typed directly into the JSX. The test passed while the chart on a
   * USDC launch was labelled INJ and scaled by 1e18, drawing an axis that ran to
   * 0.000000000085 for a launch graduating at 85 USDC.
   *
   * A guard that catches one way of writing a defect is not a guard against the
   * defect. This one looks for the ticker itself.
   *
   * `quoteLabel = 'INJ'` as a DEFAULT is allowed: it is the correct answer for the
   * default quote and the callers that show a specific launch override it.
   */
  const offenders: string[] = [];
  for (const rel of PER_LAUNCH) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    for (const m of src.matchAll(/\bINJ\b/g)) {
      const around = src.slice(Math.max(0, m.index! - 40), m.index! + 10);
      if (/quoteLabel\s*=\s*'$/.test(src.slice(0, m.index!).slice(-14))) continue;
      offenders.push(`${rel}: …${around.replace(/\s+/g, ' ').trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'a ticker is hardcoded on a per-launch surface');
});

test('the curve axis derives its scale from the quote, not a constant', () => {
  /*
   * WHAT THE TEXT GUARDS ABOVE CANNOT SEE. Mutation-checked: reverting
   * `unitFor(quoteDecimals)` to `unitFor(18)` leaves every other test in this file
   * green, because nothing about that change is a string. The label would be right
   * and the axis would run to 0.000000000085 on a launch graduating at 85 USDC.
   *
   * A guard built from source text catches how a defect is SPELLED. The scale is
   * arithmetic, so it needs its own assertion, and this is the cheapest one that
   * actually binds: the unit must come from the prop.
   */
  const src = stripComments(readFileSync(join(SRC, 'components/CurveChart.tsx'), 'utf8'));
  assert.match(
    src,
    /unitFor\(\s*quoteDecimals\s*\)/,
    'the curve axis is scaled by a constant rather than by the launch\u2019s quote',
  );
  assert.ok(
    !/const ONE = \d/.test(src),
    'a hardcoded unit is back in CurveChart',
  );
  /*
   * And the quote is not optional. A default here is what let `CreateLaunch` call the
   * chart bare for a year's worth of commits, so restoring one to make a new call site
   * compile would reopen the defect without changing a single line of the chart's maths.
   */
  for (const prop of ['quoteLabel', 'quoteDecimals']) {
    assert.ok(
      !new RegExp(`${prop}\\s*[=?]`).test(src),
      `${prop} is optional or defaulted again, so a call site can omit the launch\u2019s quote`,
    );
  }
});

/** Every `.tsx` under `src/`, so a guard over call sites cannot go stale by omission. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every curve chart is handed the quote it is drawing', () => {
  /*
   * WHAT THE GUARD ABOVE CANNOT SEE, AND THE DEFECT IT LET THROUGH. `quoteLabel` and
   * `quoteDecimals` are optional props defaulting to INJ at 18 decimals, which is
   * right for the default pair, so `CurveChart` passed every assertion in this file
   * while `CreateLaunch` called it bare. With the 6-decimal E2EUSD pair selected the
   * chart on the create screen read `0 INJ raised` and `0.0 INJ`, under the caption
   * "Drawn from the same maths the contract charges, so this is the shape buyers will
   * actually pay", beside a row saying the curve tops out at 15,689.37 E2EUSD.
   *
   * A default that is correct for the default case is not a safe default: it reinstates
   * the defect at any call site that forgets, silently, and checking that the component
   * USES a prop is not checking that anyone PASSES it. So this reads the call sites,
   * found by walking the tree rather than listed, since a new chart added later is the
   * case a named list would miss.
   *
   * Both props are now REQUIRED, so `tsc` refuses a bare call and this test is the
   * second line rather than the first. It is still the one that binds, because what
   * `tsc` cannot see is somebody restoring the default to make a new call site compile,
   * which is exactly how the defect got in. The test below pins that too.
   */
  const sites: string[] = [];
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<CurveChart\b([\s\S]*?)\/>/g)) {
      const rel = file.slice(SRC.length + 1);
      sites.push(rel);
      for (const prop of ['quoteLabel', 'quoteDecimals']) {
        if (!new RegExp(`\\b${prop}=`).test(m[1])) offenders.push(`${rel}: no ${prop}`);
      }
    }
  }
  // Anti-vacuity: a rename would otherwise leave this passing over nothing.
  assert.ok(sites.length >= 2, `expected the chart to be used, found ${sites.length} call sites`);
  assert.deepEqual(offenders, [], 'a curve chart is drawing a launch in the default quote');
});

test('a ticker and a scale are one prop pair, and neither is optional', () => {
  /*
   * THE CLASS, RATHER THAN THE TWO INSTANCES OF IT. `CurveChart` had its own test above
   * because its axis was labelled INJ and scaled by 1e18; `LaunchPreview` then shipped
   * the same defect in the half nobody guards, by taking `quoteLabel` and NOT taking a
   * scale at all - so `fmt(openingBuy, 18, 4)` stood next to a dynamic ticker and every
   * opening buy on the 6-decimal pair read `0 E2EUSD`.
   *
   * A component that accepts a ticker is rendering somebody's quote, so it needs the
   * decimals of that quote in the same breath. Declaring one without the other is the
   * omission to refuse, and both must be required: a default is right for the default
   * pair, which is what makes it survive review.
   */
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(SRC.length + 1);
    /*
     * Deliberately not anchored to the line start. `TradeTicker` declares both on one
     * line inside an inline array type and `page.tsx` builds them in an object literal,
     * so an anchored pattern skips the two files that carry a quote furthest from where
     * it is formatted - which is the shape this is for.
     */
    if (!/\bquoteLabel\s*[:?]/.test(src)) continue;
    if (!/\bquoteDecimals\s*[:?]/.test(src)) {
      offenders.push(`${rel}: takes quoteLabel and no quoteDecimals`);
    }
    for (const prop of ['quoteLabel', 'quoteDecimals']) {
      if (new RegExp(`\\b${prop}\\s*\\?\\s*:`).test(src)) offenders.push(`${rel}: ${prop} is optional`);
      if (new RegExp(`\\b${prop}\\s*=\\s*['\`\\d]`).test(src)) offenders.push(`${rel}: ${prop} is defaulted`);
    }
  }
  assert.deepEqual(offenders, [], 'a surface takes a ticker without the scale that goes with it');
});

test('the opening buy on the sign-off card is scaled by the chosen pair', () => {
  /*
   * WHAT THE PROP GUARD ABOVE CANNOT SEE: declaring `quoteDecimals` and then still
   * passing 18 to `fmt` typechecks, satisfies every text assertion in this file, and
   * leaves the card reading zero. So this binds the arithmetic at the one place it
   * matters, the same way the `unitFor(quoteDecimals)` assertion does for the chart.
   *
   * It is the worst row on the worst card to have this on. The heading is "Before you
   * sign", the copy underneath is "Every line here is fixed once the transaction
   * lands", and the opening buy is the only figure on it the creator typed themselves -
   * shown as 0 while the share of supply beside it, computed from the same value,
   * was right.
   */
  const src = stripComments(readFileSync(join(SRC, 'components/LaunchPreview.tsx'), 'utf8'));
  assert.match(
    src,
    /fmt\(\s*openingBuy\s*,\s*quoteDecimals\b/,
    'the opening buy is scaled by a constant rather than by the chosen pair',
  );

  // And somebody has to pass it. Found by walking, so a second sign-off card is covered.
  const sites: string[] = [];
  const bare: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const inner = stripComments(readFileSync(file, 'utf8'));
    for (const m of inner.matchAll(/<LaunchPreview\b([\s\S]*?)\/>/g)) {
      const rel = file.slice(SRC.length + 1);
      sites.push(rel);
      if (!/\bquoteDecimals=/.test(m[1])) bare.push(`${rel}: no quoteDecimals`);
    }
  }
  assert.ok(sites.length >= 1, `expected the sign-off card to be used, found ${sites.length} call sites`);
  assert.deepEqual(bare, [], 'a sign-off card is pricing an opening buy in the default quote');
});

test('the create form states the reserve the chosen pair actually opens at', () => {
  /*
   * THE SAME DEFECT IN COPY RATHER THAN IN ARITHMETIC, and the worse half: the two rows
   * it broke are badged "fixed" and are the terms of something a creator can never
   * change afterwards. `OPENING_RESERVE_QUOTE` is 676, documented in its own file as
   * "only the INJ default, for copy that is about the launchpad rather than about a
   * launch", and the form printed it beside whatever ticker was SELECTED:
   *
   *     Graduates at E2EUSD raised   1915 E2EUSD   fixed
   *     Opening reserve              676 E2EUSD    fixed
   *     Curve ceiling                15,689.37 E2EUSD
   *
   * Measured on both deployed E2EUSD curves, 16 Oct 2026: `virtual_inj` 5354000000 and
   * `graduation_target` 15169000000, i.e. 5354 and 15169 whole E2EUSD. The ceiling row
   * is built through `fixedCurveFor` and matched the chain, so the card disagreed with
   * itself and the figure that was right was the one not badged fixed.
   */
  const src = stripComments(readFileSync(join(SRC, 'components/CreateLaunch.tsx'), 'utf8'));
  /*
   * `GRADUATION_TARGET_QUOTE` was the second name checked here and no longer exists. This
   * loop refusing it was its ONLY reference in the repo, so it was deleted rather than
   * kept as a constant whose documented purpose is not to be used; TypeScript now refuses
   * what this line used to.
   */
  assert.ok(
    !src.includes('OPENING_RESERVE_QUOTE'),
    'the create form prints OPENING_RESERVE_QUOTE, which is the INJ default, beside the ' +
      'selected pair\u2019s ticker',
  );
  assert.match(
    src,
    /openingReserveWholeFor\(/,
    'the create form is not resolving the opening reserve from the chosen quote',
  );

  /*
   * And the market cap the reserve exists to set, which has the SAME two failure modes:
   * derivable and shown nowhere (it was, for months, with its own passing tests), or
   * shown from the INJ default beside the selected ticker. So this requires the call and
   * requires the resolved reserve to be the argument - `openingMarketCap()` bare would
   * typecheck, pass a test of the function, and print 630 under E2EUSD.
   */
  assert.match(
    src,
    /openingMarketCap\(openingReserve\)/,
    'the create form either no longer states the opening market cap, or is deriving it ' +
      'from something other than the chosen pair\u2019s resolved reserve',
  );
});

test('the stated terms are the terms of the curve that gets signed', () => {
  /*
   * The assertion that binds the arithmetic rather than the spelling. A card stating
   * one reserve and signing another is the failure; these two must come out of the same
   * place for every quote, including a factory too old to report one.
   */
  for (const [decimals, virtualWhole] of [
    [18, undefined],
    [6, 5_354],
    [6, undefined],
    [18, 676],
  ] as Array<[number, number | undefined]>) {
    const quote = { decimals, ...(virtualWhole === undefined ? {} : { virtualWhole }) };
    const curve = fixedCurveFor(quote);
    const unit = 10n ** BigInt(decimals);
    const stated = openingReserveWholeFor(quote);
    assert.equal(
      curve.virtualInj,
      BigInt(stated) * unit,
      `the form would state ${stated} and the curve opens at ${curve.virtualInj}`,
    );
    assert.equal(
      curve.graduationTarget,
      graduationWholeFor(stated) * unit,
      'the form would state a graduation target the curve does not have',
    );
  }
  // Anti-vacuity: the per-quote reserve is a different number, so resolving it matters.
  assert.notEqual(
    openingReserveWholeFor({ virtualWhole: 5_354 }),
    openingReserveWholeFor({}),
  );
});

/*
 * ------------------------------------------------------------------------------------
 * AND THE FALLBACK, which was five different answers to one question.
 *
 * `LaunchRow.quoteLabel` is OPTIONAL, so every surface that prints an amount had to
 * decide what to do without it, and they decided separately:
 *
 *     denomLabel(quoteDenom)   the board, Trending, King of the Hill, by-pair
 *     quoteDenom               Portfolio's totals bar: `factory/inj1…/E2EUSD`
 *     ''                       Portfolio's Value column: a bare number
 *
 * The third is the defect, and `/portfolio` is the worst screen to have it on because
 * that table deliberately interleaves quotes - its sort comment says that is fine
 * "because each row carries and shows its own ticker" - so an unlabelled row put an
 * 18-decimal INJ figure directly above a 6-decimal USDC one with nothing at all to
 * tell them apart.
 *
 * A FOURTH ANSWER WAS WRITTEN UP HERE AND WAS NOT REAL. `page.tsx` interpolates
 * `group[0].quoteLabel` into a template, which reads like a `12.5K undefined` waiting
 * to happen; `heroStats` takes `boardRows.Row`, where the field is REQUIRED, so it
 * never could be. The optional field is on a different type with a similar name. Both
 * readings were of real source and only one was of the real type.
 *
 * TWO HALVES OF ONE SCREEN DISAGREEING is the tell, the same one the creator page gave:
 * a lone odd answer reads as a considered decision rather than an omission. So the
 * fallback stopped being a thing a call site decides.
 * ------------------------------------------------------------------------------------
 */

const row = (over: Partial<LaunchRow>): LaunchRow => ({ quoteDenom: 'inj', ...over }) as LaunchRow;

test('a row with no quote label still names its asset', () => {
  assert.equal(rowQuoteLabel(row({ quoteLabel: 'E2EUSD' })), 'E2EUSD', 'the factory symbol wins');

  for (const [denom, expected] of [
    ['inj', 'INJ'],
    ['factory/inj1creator/E2EUSD', 'E2EUSD'],
    ['peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', '0xdAC1…1ec7'],
    ['ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9', 'IBC/C4CFF4…'],
  ] as Array<[string, string]>) {
    const label = rowQuoteLabel(row({ quoteDenom: denom }));
    assert.equal(label, expected, `an unlabelled ${denom} row`);
    /*
     * The three things the old call sites produced, asserted as a class rather than
     * one by one, because the next wrong answer will be a fourth spelling.
     */
    assert.notEqual(label, '', 'a money figure was left with no asset named');
    assert.notEqual(label, denom, 'the raw denom is not a ticker');
    assert.ok(!/undefined/.test(label), 'the literal string "undefined" reached a label');
  }
});

test('no surface spells the quote-label fallback for itself', () => {
  /*
   * The guard that binds, because the unit test above cannot see a call site that
   * never calls the resolver - and that is precisely how all four answers coexisted
   * for as long as they did. Found by walking the tree: a new screen rendering a
   * holding is the case a named list would miss, and `/portfolio` already was that
   * case once.
   *
   * It looks for the SHAPE of a local fallback, `.quoteLabel ??`, rather than for any
   * particular wrong answer, since `?? ''` and `?? quoteDenom` were two spellings of
   * one mistake.
   */
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/quoteLabel\s*\?\?/g)) {
      offenders.push(`${file.slice(SRC.length + 1)}: …${src.slice(m.index!, m.index! + 48).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, [], 'a component is deciding for itself what an unlabelled quote is called');

  /*
   * The half the pattern above cannot reach: a surface that interpolates the field
   * BARE has no `??` in it to find. `page.tsx` is the one that did, and it was safe
   * only because of which type it was handed - so the assertion is that it resolves,
   * not that the field is absent, since the ticker strip genuinely carries a required
   * `quoteLabel` through to `TradeTicker` and that is not this defect.
   */
  const page = stripComments(readFileSync(join(SRC, 'app/page.tsx'), 'utf8'));
  assert.match(page, /rowQuoteLabel\(/, 'the home page is no longer resolving the hero\u2019s ticker');

  /*
   * Reading the field into a LOCAL is the shape to refuse, and it has to be told apart
   * from passing it along as a prop: `quoteLabel: r.quoteLabel` hands `TradeTicker` a
   * field its own props declare as required, which is correct and is not this defect.
   * An assignment is the tell - `= something.quoteLabel` - because a local is where the
   * value stops being a typed field and becomes a string somebody will interpolate.
   */
  const reads: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/=\s*[\w.[\]]*\.quoteLabel\b/g)) {
      reads.push(`${file.slice(SRC.length + 1)}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(reads, [], 'a quote label is being read off a row into a local instead of resolved');

  // And the resolver is reached from more than one place, or it is not a resolver.
  const callers = tsxFiles(SRC).filter((f) => /rowQuoteLabel\(/.test(stripComments(readFileSync(f, 'utf8'))));
  assert.ok(callers.length >= 4, `expected the resolver to be shared, found ${callers.length} callers`);
});
