/**
 * The EVM denom form, and the two defects it closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { evmDenom, evmSymbolOf, tokenAddressOf } from './denom.ts';
import { denomLabel } from '../chain.ts';

const TOKEN = '0x97bc455e526D77E58fE78D22f49E20e96ed3deEA';

test('a token renders as its ticker, not its address', () => {
  /*
   * WHAT THIS LOOKED LIKE LIVE. denomLabel matches a hex address ANYWHERE in the
   * string and truncates it, and an EVM denom contains one, so the generic branch
   * claimed it first: every token rendered as `0x97bc…deEA`, including as the launch
   * page's heading, uppercased.
   */
  assert.equal(denomLabel(evmDenom(TOKEN, 'PAD')), 'PAD');
  assert.doesNotMatch(denomLabel(evmDenom(TOKEN, 'PAD')), /0x/, 'still rendering the address');
});

test('a denom with no symbol falls back visibly, not silently', () => {
  // The token's metadata call can fail. A truncated address is the honest fallback;
  // inventing a ticker would be worse.
  assert.match(denomLabel(evmDenom(TOKEN, '')), /0x97bc…deEA/);
  assert.equal(evmSymbolOf(evmDenom(TOKEN, '')), null);
});

test('the address is recoverable from the denom', () => {
  assert.equal(tokenAddressOf(evmDenom(TOKEN, 'PAD')), TOKEN);
  assert.equal(tokenAddressOf('factory/inj1abc/PAD'), null);
});

test('the CosmWasm forms are untouched', () => {
  // The EVM branch sits before the hex one and after the factory one, so neither
  // existing shape changes.
  assert.equal(denomLabel('factory/inj1xyz/VETTA'), 'VETTA');
  assert.equal(denomLabel('inj'), 'INJ');
  assert.match(denomLabel('ibc/ABCDEF0123'), /^IBC\//);
});

test('the board and the launch page build the denom the same way', () => {
  /*
   * They did not. listLaunchesEvm built `evm/<address>/<SYMBOL>` and
   * getLaunchDetailEvm returned the bare address, so one page named the token and
   * the other named a hex string, about the same launch. Two builders for one
   * format is the defect this codebase keeps recording.
   */
  const src = readFileSync(join(import.meta.dirname, 'adapt.ts'), 'utf8');
  const builders = [...src.matchAll(/denom: ([^,\n]+)/g)].map((m) => m[1].trim());
  assert.ok(builders.length >= 2, 'the denom assignments could not be found');
  for (const b of builders) {
    assert.match(b, /^evmDenom\(/, `adapt.ts builds a denom as \`${b}\` instead of via evmDenom()`);
  }
});
