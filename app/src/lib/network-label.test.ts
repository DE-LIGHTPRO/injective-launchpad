/**
 * Every network declares whether its balances are money, and nothing infers it.
 *
 * THE DEFECT, AND IT WAS THE WORST SENTENCE ON THE SITE. Three places tested
 * `NETWORK.name === 'mainnet'` to decide how cautious to be. The EVM deployment is
 * not called mainnet - it IS Injective mainnet, chain 1776, with real INJ - so all
 * three took the reassuring branch, and `/risks` told a user with money on the line:
 *
 *     This deployment runs on Injective testnet. Tokens and balances here are test
 *     assets with no value, and the chain can be reset.
 *
 * On the one page whose entire job is to state the risk. The header chip went amber
 * over a real-funds chain for the same reason, which inverts a safety colour.
 *
 * FOUND BY FOLLOWING THE TEST, not by reading the page: `grep` for
 * `name === 'mainnet'` found three call sites and two of them were asking the wrong
 * question. A name test spreads one decision across every caller and gets it wrong
 * the moment a network arrives that does not follow the convention.
 *
 * AND `name` WAS BEING RENDERED. The footer read "Injective evm explorer", the wallet
 * picker "No wallet found in this browser that can sign on evm". A lowercase internal
 * identifier in front of a user is the same class of leak as an env-var name, and it
 * never showed on the two networks whose identifier happens to read as a word.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { NETWORKS } from './config.ts';

const SRC = join(import.meta.dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Comment ranges blanked, so a note ABOUT a name test is not read as one. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

test('every network says outright whether a balance here is money', () => {
  for (const [name, cfg] of Object.entries(NETWORKS)) {
    assert.equal(typeof cfg.realFunds, 'boolean', `${name} does not declare realFunds`);
    assert.equal(typeof cfg.label, 'string', `${name} has no display label`);
    assert.ok(cfg.label.length > 0, `${name}'s label is empty`);
  }
  // The three that exist today, stated rather than derived: `evm` is the one a name
  // test got wrong, so it is the one worth pinning.
  assert.equal(NETWORKS.testnet.realFunds, false);
  assert.equal(NETWORKS.mainnet.realFunds, true);
  assert.equal(
    NETWORKS.evm.realFunds,
    true,
    'the EVM deployment is Injective mainnet with real INJ, whatever it is called',
  );
});

test('a display label is never the internal identifier of a network that reads badly', () => {
  /*
   * `testnet` and `mainnet` are their own labels because those words are what a reader
   * should see. `evm` is not: it is an identifier, and this is the case that was on
   * the screen.
   */
  assert.notEqual(NETWORKS.evm.label, 'evm');
  assert.match(NETWORKS.evm.label, /EVM/);
});

test('no component decides how loud to be from the network name', () => {
  /*
   * The whole class, not the three instances. A fourth caller added later asking
   * "am I on mainnet" to decide whether to warn somebody is the same defect, and this
   * fails on it the moment it is written.
   *
   * `NETWORK.name` is still legitimate for identity: picking an RPC, keying a
   * per-chain fee, or scoping a claim to one named chain's history - which is what the
   * create page's "not yet exercised on mainnet" caution does, and why that one stayed
   * a name test with a comment saying so. What is refused is a name test inside a
   * TERNARY, which is how all three screen-facing ones were written.
   */
  const offenders: string[] = [];
  for (const p of walk(join(SRC, 'components')).concat(walk(join(SRC, 'app')))) {
    const src = code(p);
    for (const m of src.matchAll(/NETWORK\.name\s*===\s*'(\w+)'\s*\?/g)) {
      const rel = p.slice(SRC.length + 1);
      // The one documented exception, which asks about an exercise history rather
      // than about whether funds are real. See the comment on it.
      if (rel === 'components/CreateLaunch.tsx' && m[1] === 'mainnet') continue;
      offenders.push(`${rel}: NETWORK.name === '${m[1]}' ? …`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a network-name test is choosing what to tell a user; use NETWORK.realFunds, which says it outright',
  );
});

test('the identifier is not rendered where the label belongs', () => {
  const offenders: string[] = [];
  for (const p of walk(join(SRC, 'components')).concat(walk(join(SRC, 'app')))) {
    const src = code(p);
    /*
     * `{NETWORK.name}` inside JSX text, which is what put "Injective evm explorer" in
     * the footer. A `className` interpolation is not this - that is a style hook
     * nobody reads - so the match requires the brace to open a JSX child or to sit in
     * a sentence, which is what `>` or a letter before it tests.
     */
    for (const m of src.matchAll(/[>\w,.]\s*\{NETWORK\.name\}/g)) {
      offenders.push(`${p.slice(SRC.length + 1)}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'NETWORK.name is being shown to a reader; NETWORK.label is the display form',
  );
});
