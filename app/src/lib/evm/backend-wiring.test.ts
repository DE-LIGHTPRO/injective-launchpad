/**
 * The EVM backend is REACHABLE, not merely written.
 *
 * THIS IS THE FAILURE THIS CODEBASE REPEATS. `getExecutionBlocker` had nine passing
 * tests and no call sites; `isCompleteAmount` had eight; `AmmVenueAdapter` was
 * registered in a registry that nothing a user could reach consumed. An EVM wallet
 * module, a balances module and a write path are exactly that shape again: each one
 * can be correct in isolation while `available()` still offers five Cosmos
 * extensions, `denomBalance` still asks an LCD that is a JSON-RPC endpoint, and the
 * button still does nothing.
 *
 * So these tests assert the SEAM rather than the implementations. The implementations
 * need a provider and a chain; the seam is what decides whether any of them is ever
 * called, and it is decided by `isEvm()` in nine functions across three files.
 *
 * `NEXT_PUBLIC_NETWORK` is set before the first import on purpose: `config.ts`
 * resolves `NETWORK` at module load, and `node --test` gives each file its own
 * process, so this file is an EVM build and `backend-wiring-cosmwasm.test.ts` is a
 * CosmWasm one. Setting it after the import would read the testnet config and every
 * assertion below would pass for the wrong reason.
 */
process.env.NEXT_PUBLIC_NETWORK = 'evm';

import test from 'node:test';
import assert from 'node:assert/strict';

const { isEvm, NETWORK } = await import('../config.ts');
const wallet = await import('../wallet.ts');
const { railStage } = await import('../broadcast.ts');

test('the fixture really is an EVM build, or nothing below measures anything', () => {
  assert.equal(isEvm(), true);
  assert.equal(NETWORK.chainId, '1776');
});

test('the picker offers the one EIP-1193 row, not five Cosmos extensions', () => {
  const names = wallet.walletOptions().map((w) => w.name);
  assert.deepEqual(names, ['evm']);
  /*
   * Named, not just counted. Offering "Keplr" on an EVM deployment would put a button
   * on the header for a wallet that cannot sign anything this factory accepts, and the
   * user would learn that from a failure rather than from the list.
   */
  for (const cosmos of ['keplr', 'leap', 'cosmostation', 'ninji', 'owallet']) {
    assert.ok(!names.includes(cosmos as never), `${cosmos} is offered on an EVM build`);
  }
});

test('available() reads the EVM provider and ignores a Cosmos global', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadKeplr = 'keplr' in g;
  const hadEth = 'ethereum' in g;
  try {
    // A browser can plainly have Keplr installed on an EVM deployment. It must not
    // make the picker offer it, and it must not stand in for an EVM wallet.
    g.keplr = { enable: () => {}, getKey: () => {} };
    delete g.ethereum;
    assert.deepEqual(wallet.available(), [], 'a Cosmos extension counted as an EVM wallet');

    g.ethereum = { request: () => Promise.resolve([]) };
    assert.deepEqual(wallet.available(), ['evm']);

    // A stub with no `request` is not a wallet: offering it produces a "not a
    // function" at the moment the user clicks, which reads as the app being broken.
    g.ethereum = { isMetaMask: true };
    assert.deepEqual(wallet.available(), [], 'a provider with no request() was offered');
  } finally {
    if (!hadKeplr) delete g.keplr;
    if (!hadEth) delete g.ethereum;
  }
});

test('a remembered Cosmos wallet is not restored on an EVM build', () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g;
  const store = new Map<string, string>();
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  try {
    /*
     * The hazard is a browser that connected Keplr on the CosmWasm deployment and
     * then visited the EVM one on the same origin: `localStorage` survives, and
     * `reconnect()` would be handed a name its backend cannot serve. The same shape
     * as a chain-scoped id outliving a network flip.
     */
    store.set('injpad:wallet', 'keplr');
    assert.equal(wallet.lastWallet(), null);

    store.set('injpad:wallet', 'evm');
    assert.equal(wallet.lastWallet(), 'evm');
  } finally {
    if (!had) delete g.window;
  }
});

test('an unrecognised denom reads as unknown, never as zero', async () => {
  const { denomBalanceEvm } = await import('./balances.ts');
  const holder = '0x1111111111111111111111111111111111111111';

  /*
   * A `factory/…` denom reaching the EVM balance read means something upstream mixed
   * the backends. Answering zero would tell a holder their position is empty for a
   * token they may well hold; `null` is "not read", which is what every other balance
   * read in this app returns for the same reason.
   */
  assert.equal(await denomBalanceEvm(holder, 'factory/inj1abc/PAD'), null);
  assert.equal(await denomBalanceEvm(holder, 'evm/not-an-address/PAD'), null);
  // A bad holder is also unknown rather than zero, and is refused before any request.
  assert.equal(await denomBalanceEvm('inj1notanevmaddress', NETWORK.quoteDenom), null);
});

test('the approval prompt is reported as signing, never as a stage the dialog lacks', () => {
  const seen: string[] = [];
  const report = railStage((s) => seen.push(s));
  assert.ok(report);
  report('approving');
  report('signing');
  report('broadcasting');
  report('settling');
  /*
   * `TxDialog`'s STEPS list is documented as one entry per real step, with the index
   * IN that array as the progress, so a stage it does not carry has index -1 and the
   * rail draws nothing. `approving` has no entry on purpose: it cannot happen on a buy
   * and never happens on CosmWasm, so a sixth step would be a stage the user is told
   * about and does not reach. It is reported as what it is to them - their wallet
   * asking for a signature.
   */
  assert.deepEqual(seen, ['signing', 'signing', 'broadcasting', 'settling']);
  assert.equal(railStage(undefined), undefined);
});

test('a batch that fails part way says so, and one that fails at the start does not', async () => {
  const { executeManyEvm, EvmPartialBatchError } = await import('./write.ts');
  const calls = [
    { contract: '0xaaa', msg: { claim_fees: {} } },
    { contract: '0xbbb', msg: { claim_fees: {} } },
    { contract: '0xccc', msg: { claim_fees: {} } },
  ];

  const order: string[] = [];
  const ok = await executeManyEvm(calls, '0xsender', undefined, async (o) => {
    order.push(o.contract);
    return { hash: `0x${o.contract.slice(2)}` as never, height: 7 };
  });
  // In order, and the LAST receipt is the one returned: the dialog's hash should be
  // the transaction the user was last waiting on.
  assert.deepEqual(order, ['0xaaa', '0xbbb', '0xccc']);
  assert.equal(ok.hash, '0xccc');

  /*
   * THE CASE THAT MATTERS. Two claims landed and moved real money; the third failed.
   * Reporting that as a plain failure tells the creator nothing happened, and the
   * claim page would leave two rows showing fees that have already been paid out.
   */
  let n = 0;
  await assert.rejects(
    () =>
      executeManyEvm(calls, '0xsender', undefined, async (o) => {
        if (++n === 3) throw new Error('reverted');
        return { hash: `0x${o.contract.slice(2)}` as never, height: 7 };
      }),
    (e: Error) => {
      assert.ok(e instanceof EvmPartialBatchError, `got ${e.name}`);
      assert.equal((e as InstanceType<typeof EvmPartialBatchError>).landed, 2);
      assert.equal((e as InstanceType<typeof EvmPartialBatchError>).total, 3);
      assert.match(e.message, /2 of 3/);
      // The cause is kept: without it the sentence is arithmetic with no diagnosis.
      assert.match(e.message, /reverted/);
      return true;
    },
  );

  // Nothing landed, so the user's own error is what they should read. "0 of 3 landed"
  // would hide a closed wallet prompt behind a count.
  await assert.rejects(
    () =>
      executeManyEvm(calls, '0xsender', undefined, async () => {
        throw new Error('you closed the wallet prompt');
      }),
    (e: Error) => {
      assert.ok(!(e instanceof EvmPartialBatchError));
      assert.match(e.message, /closed the wallet prompt/);
      return true;
    },
  );

  await assert.rejects(() => executeManyEvm([], '0xsender'), /Nothing to send/);
});
