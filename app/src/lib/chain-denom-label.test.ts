import test from 'node:test';
import assert from 'node:assert/strict';
import { denomLabel } from './chain.ts';

test('a launched token keeps its ticker', () => {
  assert.equal(denomLabel('factory/inj1abc/KAIJU'), 'KAIJU');
});

test('an ERC20 denom is shortened, not uppercased whole', () => {
  /*
   * `symbolOf` returned the entire 42-character address here, uppercased, which in a
   * select is unreadable. The address still identifies the asset once shortened.
   */
  assert.equal(
    denomLabel('erc20:0x05148C203a48103da989090CC882543eF8724f78'),
    '0x0514…4f78',
  );
});

test('no ticker is invented for an asset whose name is not in the string', () => {
  /*
   * The temptation is to map known addresses to "USDC". The app has no registry, and
   * guessing is how a launchpad ends up labelling an arbitrary token as a stablecoin,
   * which is the one mislabel that actually costs someone money.
   */
  const label = denomLabel('erc20:0x05148C203a48103da989090CC882543eF8724f78');
  assert.ok(!/USDC|USD/i.test(label), 'a ticker was invented from an address');
});

test('a bare denom is already a ticker', () => {
  assert.equal(denomLabel('inj'), 'INJ');
});

test('an IBC denom is named as one rather than as a hash', () => {
  assert.ok(denomLabel('ibc/ABCDEF0123456789').startsWith('IBC/'));
});
