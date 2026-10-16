/**
 * The highest fee a buy can pay is 20%, and the Risks page said 10%.
 *
 * THE DEFECT THIS EXISTS FOR. Under "What the contracts do enforce" - a heading whose
 * whole value is that it is not marketing - `/risks` read:
 *
 *   "A creator sets the fee rate itself, capped at 10% per side."
 *
 * True of the base rate and not true of what a buyer pays. `MAX_FEE_BPS` is 1000 in
 * `contracts/factory/src/lib.rs`, but `MAX_EARLY_FEE_BPS` is **2000** in
 * `contracts/curve/src/state.rs`, deliberately double, because an opening fee only
 * deters sniping if being first costs something. So the page understated the worst case
 * a buyer faces by half, on the one page written for the reader who wants the
 * unvarnished version.
 *
 * It got the split wrong too. The page said the fee divides 70/30 between creator and
 * launchpad with nothing changeable afterwards, which is right about the base fee and
 * wrong about the premium: `contract.rs` computes
 * `premium_bps = effective_fee_bps(..).saturating_sub(cfg.curve.fee_bps)` and adds the
 * premium to `state.lp_bonus`, carved off BEFORE the split, ending up in the locked
 * pool. Nobody is paid it.
 *
 * WHY A SOURCE GUARD. The sentence was locally consistent and quoted a real constant -
 * it interpolated `MAX_FEE_BPS` rather than typing 10, which is exactly the habit that
 * normally prevents this. It named the wrong one of two caps, and reads perfectly on
 * every subsequent pass. The create form (`launchRules.ts:204`) and the launch page
 * (`describeRules`) were already correct, so no behavioural test was wrong either:
 * only the prose was, which is the failure mode copy review does not catch.
 *
 * The constant was ALSO written twice - `MAX_EARLY_FEE_BPS` here and
 * `MAX_EARLY_FEE_PCT = 20` in `boardMetrics.ts`, each with a comment saying it mirrors
 * the contract. Pinning copy to a constant is worthless while there are two constants
 * to drift apart, so the duplicate is gone and this test asserts it stays gone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MAX_EARLY_FEE_BPS } from './launchRules.ts';
import { MAX_FEE_BPS } from './launchLimits.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const REPO = join(SRC, '..', '..');

/*
 * Comment ranges blanked through the shared helper, so prose below can discuss what
 * the copy must not say. Not a local copy: this guard's first draft masked `//`
 * naively, which blanks the rest of any line holding an `https://` - the exact way
 * `explorer-host` was made vacuous while the thing it watched was broken.
 */
const userFacingText = maskComments;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function rust(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

test('both fee caps match the contracts that enforce them', () => {
  /*
   * The anchor. Every figure below is only as good as the mirror being right, and a
   * mirror that drifts fails here rather than on a page nobody re-reads.
   */
  const base = /pub const MAX_FEE_BPS: u16 = ([\d_]+);/.exec(rust('contracts/factory/src/lib.rs'));
  const early = /pub const MAX_EARLY_FEE_BPS: u16 = ([\d_]+);/.exec(
    rust('contracts/curve/src/state.rs'),
  );
  assert.ok(base, 'MAX_FEE_BPS is no longer declared in the factory');
  assert.ok(early, 'MAX_EARLY_FEE_BPS is no longer declared in the curve');
  assert.equal(MAX_FEE_BPS, Number(base[1].replace(/_/g, '')), 'the base fee cap mirror drifted');
  assert.equal(
    MAX_EARLY_FEE_BPS,
    Number(early[1].replace(/_/g, '')),
    'the opening fee cap mirror drifted',
  );
  // And the shared math crate, which is what the curve actually charges against.
  const math = /pub const MAX_FEE_BPS: u16 = ([\d_]+);/.exec(rust('packages/launchpad-math/src/lib.rs'));
  assert.ok(math, 'MAX_FEE_BPS is no longer declared in launchpad-math');
  assert.equal(
    Number(math[1].replace(/_/g, '')),
    MAX_FEE_BPS,
    'the factory and the math crate disagree about the base fee cap',
  );
});

test('the opening cap really is the higher of the two, so naming one is a choice', () => {
  /*
   * Anti-vacuity. If the two caps were equal this whole guard would be protecting a
   * distinction that does not exist, and the original sentence would have been fine.
   */
  assert.ok(
    MAX_EARLY_FEE_BPS > MAX_FEE_BPS,
    'the caps no longer differ; the copy rule below is moot and should be revisited',
  );
});

test('the risks page states the opening ceiling, not only the base cap', () => {
  const page = readFileSync(join(SRC, 'app/risks/page.tsx'), 'utf8');
  assert.match(
    page,
    /MAX_EARLY_FEE_BPS \/ 100/,
    'the risks page no longer quotes the opening fee ceiling, so its stated cap is half ' +
      'the most a buy can pay',
  );
  assert.match(
    page,
    /MAX_FEE_BPS \/ 100/,
    'the risks page no longer quotes the base fee cap',
  );
  const text = userFacingText(page);
  assert.match(
    text,
    /highest\s+a buy can ever pay/,
    'nothing on the page says which of the two caps is the one a buyer faces',
  );
  assert.match(
    text,
    /into the pool at graduation rather than to the\s+creator or to us/,
    'the page no longer says where the premium goes, so its 70/30 claim covers a ' +
      'portion that is not split',
  );
});

test('the premium still goes to the pool rather than the split', () => {
  /*
   * The other half: the sentence above is honest only while the contract keeps doing
   * this. If the premium were ever folded into the fee split, the page would be
   * reassuring a buyer about a payment that now reaches the creator.
   */
  const curve = rust('contracts/curve/src/contract.rs');
  assert.match(
    curve,
    /premium_bps = effective_fee_bps\(&cfg, env\.block\.time\)\.saturating_sub\(cfg\.curve\.fee_bps\)/,
    'the premium is no longer the amount above the curve fee',
  );
  assert.match(
    curve,
    /state\.lp_bonus = state\.lp_bonus\.checked_add\(premium\)\?/,
    'the opening premium no longer accrues to lp_bonus, so the risks copy is now wrong',
  );
});

test('the opening ceiling is declared once in the app', () => {
  /*
   * `MAX_EARLY_FEE_PCT = 20` lived in boardMetrics.ts with its own "mirrors the
   * contract" comment while launchRules.ts held the bps form. Two mirrors of one
   * number is two chances to be wrong and no way for either to notice.
   */
  const declarations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = userFacingText(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/export const (MAX_EARLY_FEE_\w+)/g)) {
      declarations.push(`${relative(SRC, file)} ${m[1]}`);
    }
  }
  assert.deepEqual(
    declarations,
    ['lib/launchRules.ts MAX_EARLY_FEE_BPS'],
    'the opening fee ceiling is declared somewhere else as well; derive it from ' +
      'MAX_EARLY_FEE_BPS instead',
  );
});

test('no screen applies the creator share to "every" fee', () => {
  /*
   * The same defect one surface over, and the one that is about somebody's money
   * rather than their risk. `/claim`, `ClaimFees`, `CreateLaunch` and `FeeEarnings`
   * all said a version of "70% of every trading fee is yours". Not every: the opening
   * premium is subtracted before `split_fee` is reached, so a creator who sets a 20%
   * opening fee on a 1% launch earns 70% of the 1% and nothing at all from the 19%.
   *
   * On the create form that mattered most, because the creator sets the opening fee
   * on the same screen and could reasonably read the two fields together.
   */
  const banned = [
    /\b\d{1,2}%\s+of\s+every\s+trading\s+fee/i,
    /\bof\s+every\s+trading\s+fee\s+is\s+yours/i,
    /Every trade pays \{Number\(feeBps\)/,
    /pays you \d{1,2}% of its fee/i,
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = userFacingText(readFileSync(file, 'utf8'));
    for (const re of banned) {
      const m = re.exec(text);
      if (m) offenders.push(`${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the share applies to the launch\u2019s own fee rate, not to the opening premium. ' +
      `Name the rate it splits.\n  ${offenders.join('\n  ')}`,
  );
});

test('the fee shares are interpolated rather than typed', () => {
  /*
   * `70%` and `30%` appeared as literals in four strings beside code that already
   * imported the constants. A split is a thing a launchpad could plausibly change, and
   * the figure a creator reads must move with it rather than being remembered.
   *
   * Scoped to a share-shaped sentence so an SVG `width="100%"` and a genuine
   * `fee of 100% or more` guard are untouched; the point is the claim, not the glyph.
   */
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = userFacingText(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(
      /(?<![\d.{])(\d{1,2})%(?=[^.]{0,40}\b(share|of (?:that|the|each|every) fee|is yours|accrues|runs (?:this|the) launchpad)\b)/gi,
    )) {
      offenders.push(`${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'interpolate CREATOR_FEE_SHARE_BPS or PLATFORM_FEE_SHARE_BPS.\n  ' + offenders.join('\n  '),
  );
});

test('no screen quotes a fee ceiling as a bare number', () => {
  /*
   * The habit that would reintroduce this: writing "up to 20%" in a sentence. It is
   * right today and silently wrong the moment either cap moves, and the create form
   * would keep validating against the constant while the copy promised something else.
   */
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = userFacingText(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/(?:up to|capped at|most)\s+(\d{1,2})%/gi)) {
      offenders.push(`${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'interpolate MAX_FEE_BPS or MAX_EARLY_FEE_BPS rather than typing the percentage.\n  ' +
      offenders.join('\n  '),
  );
});
