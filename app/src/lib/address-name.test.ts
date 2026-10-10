/**
 * Generated creator names, and the ways a display label becomes a false claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { addressName, NAME_SPACE } from './addressName.ts';

const A = 'inj1x339v5qxkvc5qa6lfagzcc7rvgl4v4usjytmfw';
const B = 'inj1hdlfy7h0e5gphml6a4aakpy8f7j3n9qnxj80ep';

test('the same address is always the same name', () => {
  /*
   * The whole point: a visitor should be able to notice that the same person made
   * three launches on one board. A name that varies between renders or devices tells
   * them the opposite, and does it convincingly.
   */
  assert.equal(addressName(A), addressName(A));
  assert.equal(addressName(A), addressName(`  ${A.toUpperCase()}  `), 'case or spacing changed the name');
});

test('different addresses get different names, at least for the ones on screen', () => {
  // Not a guarantee, because 65,536 names cannot cover every address. It does need to
  // hold for a handful, or a board reads as one person having made everything.
  assert.notEqual(addressName(A), addressName(B));
});

test('the space is large enough to be worth having', () => {
  /*
   * With 65,536 names a board of 50 launches has roughly a 2% chance of any
   * collision, which is the level where the label is useful. Pinned, because
   * trimming a word list to tidy it is an easy change with a non-obvious cost.
   */
  assert.equal(NAME_SPACE, 65_536);
});

test('names are spread, not clustered on one word', () => {
  /*
   * The defect this catches: taking `h % 32` three times gives three CORRELATED
   * choices, so most addresses land on a handful of names and the label stops
   * distinguishing anyone. Each word takes its own slice of the hash for that reason.
   */
  const names = new Set<string>();
  const firsts = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const n = addressName(`inj1test${i}`);
    names.add(n);
    firsts.add(n.slice(0, 4));
  }
  assert.ok(names.size > 480, `only ${names.size} distinct names from 500 addresses`);
  assert.ok(firsts.size > 10, `the first word only took ${firsts.size} values`);
});

test('an empty or missing address does not get a plausible name', () => {
  /*
   * A generated name for nothing would read as a real creator. "Unknown" is the only
   * honest output when there is no address to derive from.
   */
  assert.equal(addressName(''), 'Unknown');
  assert.equal(addressName('   '), 'Unknown');
});

test('no word in the pool characterises the person it lands on', () => {
  /*
   * A generated name attaches to a stranger who had no say in it. Labelling someone
   * "ShadyCopperRat" by hash would be an accusation the data cannot support, and a
   * launchpad doing it to a creator is defamation by random number.
   */
  const loaded = [
    'shady', 'sketch', 'rug', 'scam', 'fake', 'rat', 'snake', 'thief',
    'dirty', 'greedy', 'lazy', 'ugly', 'dumb', 'weak',
  ];
  const sample = new Set<string>();
  for (let i = 0; i < 3_000; i += 1) sample.add(addressName(`inj1w${i}`).toLowerCase());
  for (const bad of loaded) {
    for (const name of sample) {
      assert.ok(!name.includes(bad), `the name pool can produce "${name}", containing "${bad}"`);
    }
  }
});
