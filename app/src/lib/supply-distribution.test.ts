/**
 * Where a launch page says the supply is.
 *
 * The defect this exists for: migration repurposes the two fields the launch page was
 * reading. `seed_pool` sets `tokens_sold = curve_supply` and moves `lp_reserve + unsold`
 * into the pool, so afterwards `tokensSold` is a constant rather than a count and
 * `lpReserve` is what WAS held back rather than what is now locked. The page printed
 * both in the present tense.
 *
 * The fixture below is the live testnet launch E2E88375 as the chain reported it,
 * checked against the bank module rather than the contract's own report of itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tokenDistribution, type CurveConfig, type CurveState } from './curve.ts';

const ONE = 10n ** 18n;

const CURVE_SUPPLY = 800_000_000n * ONE;
const LP_RESERVE = 200_000_000n * ONE;
const TOTAL_SUPPLY = 1_000_000_000n * ONE;

const cfg: CurveConfig = {
  virtualInj: 30n * ONE,
  virtualTokens: CURVE_SUPPLY,
  curveSupply: CURVE_SUPPLY,
  graduationTarget: 15_169n * ONE,
  feeBps: 100n,
  feeSellBps: 100n,
};

/** The contract's own token balance after migration, measured on E2E88375. */
const POOL_TOKENS = 466_641_431_436_227_154_771_311_462n;

const migrated: CurveState = {
  // Both repurposed by `seed_pool`, which is the whole hazard.
  injCollected: 0n,
  tokensSold: CURVE_SUPPLY,
  graduated: true,
};

test('a migrated launch reports the pool, not the curve', () => {
  const d = tokenDistribution(cfg, migrated, LP_RESERVE, {
    quote: 3_358_137n,
    tokens: POOL_TOKENS,
  });
  assert.equal(d.kind, 'pool');
  if (d.kind !== 'pool') return;

  /*
   * The measured numbers. The page used to claim 800,000,000 sold and 200,000,000 held
   * back for liquidity, which overstated sales by 1.5x and understated the locked pool
   * by 2.33x on a launch badged "Liquidity locked".
   */
  assert.equal(d.inPool, POOL_TOKENS);
  assert.equal(d.outside, TOTAL_SUPPLY - POOL_TOKENS);
  assert.equal(d.inPool + d.outside, TOTAL_SUPPLY, 'the two rows must account for the supply');

  // And the repurposed fields reach no row: 200,000,000 and 800,000,000 appear nowhere.
  assert.notEqual(d.inPool, LP_RESERVE);
  assert.notEqual(d.outside, CURVE_SUPPLY);
});

test('a live launch still reports the curve, from the count rather than a constant', () => {
  const sold = 495_558n * ONE;
  const d = tokenDistribution(
    cfg,
    { injCollected: 2_473_000n, tokensSold: sold, graduated: false },
    LP_RESERVE,
    null,
  );
  assert.equal(d.kind, 'curve');
  if (d.kind !== 'curve') return;
  assert.equal(d.sold, sold);
  assert.equal(d.curveSupply, CURVE_SUPPLY);
  assert.equal(d.onCurve, CURVE_SUPPLY - sold);
  assert.equal(d.heldBack, LP_RESERVE);
  assert.equal(d.sold + d.onCurve, CURVE_SUPPLY);
});

test('the pool branch is the pool existing, never the graduated flag', () => {
  /*
   * NOT because the chain can disagree: it cannot. `exec_buy` sets `graduated` and calls
   * `seed_pool` in the same transaction (contract.rs:290-297, "there is no window in
   * which the curve is closed and the pool not yet open"), and the `graduated &&
   * !migrated` branches in `exec_buy`/`exec_sell` exist only so a curve can never be
   * stuck there. I first wrote this test asserting that window was reachable, which the
   * contract says in as many words that it is not - the claim was mine, not measured.
   *
   * It is still the right branch for a reason that survives that correction: `pool` and
   * `graduated` reach the client separately, `pool` being derived from `migrated` at the
   * chain boundary, and the pool rows have nothing to read unless `pool` is actually
   * there. Branching on the flag and then reading a null pool is how two rows end up
   * saying 0 and "the entire supply is outside the pool".
   */
  const d = tokenDistribution(cfg, migrated, LP_RESERVE, null);
  assert.equal(d.kind, 'curve', 'a sold-out curve with no pool yet reported pool reserves');
});

test('a pool holding more than the supply reports no negative float', () => {
  // Cannot happen from `seed_pool`, and a negative token count rendered with a minus sign
  // is the one output worse than a wrong one.
  const d = tokenDistribution(cfg, migrated, LP_RESERVE, {
    quote: 1n,
    tokens: TOTAL_SUPPLY + ONE,
  });
  assert.equal(d.kind, 'pool');
  if (d.kind !== 'pool') return;
  assert.equal(d.outside, 0n);
});

test('a sold count above the curve supply does not go negative either', () => {
  const d = tokenDistribution(cfg, { ...migrated, tokensSold: CURVE_SUPPLY + ONE }, LP_RESERVE, null);
  assert.equal(d.kind, 'curve');
  if (d.kind !== 'curve') return;
  assert.equal(d.onCurve, 0n);
  assert.equal(d.sold, CURVE_SUPPLY);
});

/*
 * AND THAT THE PAGE GOES THROUGH IT. The arithmetic above is only worth anything if the
 * launch page is not still subtracting the repurposed fields inline, which is exactly what
 * it did. Tree-walked rather than named, because a hardcoded file list is how
 * `quote-labelling.test.ts` went stale without failing.
 */
test('no rendered surface derives the supply split from the repurposed fields itself', () => {
  /*
   * `curveSupply - tokensSold` is the derivation that reads 0 after migration. Matched
   * against whatever object it hangs off, since the launch page spelt it
   * `detail.config.curveSupply - detail.state.tokensSold`.
   */
  const INLINE = /curveSupply\s*-\s*[\w.]*\btokensSold\b/;
  // Anti-vacuity: the pattern is asserted against the spelling it was written for, so a
  // field rename leaves this failing rather than passing over nothing.
  assert.match('detail.config.curveSupply - detail.state.tokensSold', INLINE);

  const SRC = join(import.meta.dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(SRC);

  const callers: string[] = [];
  const offenders: string[] = [];
  let rendered = 0;
  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/\/\/[^\n]*/g, '');
    if (rel !== 'lib/curve.ts' && /\btokenDistribution\s*\(/.test(src)) callers.push(rel);
    /*
     * Only what renders. `lib/demo.ts` writes the same subtraction and is CORRECT: it
     * seeds a demo pool exactly as `seed_pool` does, `lp_reserve + unsold`, which is the
     * one place the expression means what it says. The defect is a metric row stating it
     * as a present-tense holding, so this looks where rows are written.
     */
    if (!rel.endsWith('.tsx')) continue;
    rendered += 1;
    if (INLINE.test(src)) offenders.push(`${rel}: derives the remaining curve supply inline`);
  }
  assert.ok(rendered >= 20, `expected to have scanned the components, saw ${rendered}`);
  assert.ok(callers.length >= 1, `expected the split to be read somewhere, found ${callers.length}`);
  assert.deepEqual(offenders, [], 'a surface subtracts a field that migration repurposed');
});
