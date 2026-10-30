/**
 * The EVM branches do NOT fire on a CosmWasm build.
 *
 * THE OTHER HALF OF `backend-wiring.test.ts`, and the half that is easy to leave out.
 * Nine functions across `wallet.ts`, `chain.ts` and `broadcast.ts` gained an
 * `isEvm()` branch, and a guard that only ever runs with `NEXT_PUBLIC_NETWORK=evm`
 * cannot tell a correct branch from one that is taken unconditionally. Inverting a
 * condition, or dropping the `if` and leaving the body, would pass every assertion in
 * that file and break the deployment this repository ships by default.
 *
 * Same process-per-file reasoning: this one is a testnet build, so `isEvm()` is false
 * here and true there, and the two files measure the same seam from both sides.
 */
process.env.NEXT_PUBLIC_NETWORK = 'testnet';

import test from 'node:test';
import assert from 'node:assert/strict';

const { isEvm, NETWORK } = await import('../config.ts');
const wallet = await import('../wallet.ts');

test('the fixture really is a CosmWasm build', () => {
  assert.equal(isEvm(), false);
  assert.equal(NETWORK.chainId, 'injective-888');
});

test('the picker still offers the five Cosmos extensions and not the EVM row', () => {
  const names = wallet.walletOptions().map((w) => w.name);
  assert.deepEqual(names, ['keplr', 'leap', 'ninji', 'cosmostation', 'owallet']);
  assert.ok(!names.includes('evm' as never), 'the EVM row leaked onto a CosmWasm build');
  /*
   * Same rows as `SUPPORTED`, in the same order. `walletOptions()` replaced a direct
   * read of `SUPPORTED` in the header, and a reordering or an omission here would
   * change the picker with nothing else failing.
   */
  assert.deepEqual(names, wallet.SUPPORTED.map((w) => w.name));
  for (const o of wallet.walletOptions()) {
    const row = wallet.SUPPORTED.find((w) => w.name === o.name);
    assert.ok(row, `${o.name} is offered but not in SUPPORTED`);
    assert.equal(o.label, row.label);
    assert.equal(o.install, row.install);
  }
});

test('an injected EVM provider does not make a Cosmos build offer a wallet', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadEth = 'ethereum' in g;
  const hadKeplr = 'keplr' in g;
  try {
    /*
     * MetaMask is installed in a great many browsers, so this is the common case
     * rather than a contrived one. On a CosmWasm deployment it can sign nothing this
     * factory accepts, and offering it would be the mirror of offering Keplr on the
     * EVM build.
     */
    g.ethereum = { request: () => Promise.resolve([]) };
    delete g.keplr;
    assert.deepEqual(wallet.available(), []);

    g.keplr = { enable: () => {}, getKey: () => {} };
    assert.deepEqual(wallet.available(), ['keplr']);
  } finally {
    if (!hadEth) delete g.ethereum;
    if (!hadKeplr) delete g.keplr;
  }
});

test('a remembered EVM wallet is not restored on a CosmWasm build', () => {
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
    store.set('injpad:wallet', 'evm');
    assert.equal(wallet.lastWallet(), null);
    store.set('injpad:wallet', 'leap');
    assert.equal(wallet.lastWallet(), 'leap');
  } finally {
    if (!had) delete g.window;
  }
});

test('reconnect on a CosmWasm build never reaches the EVM path', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadEth = 'ethereum' in g;
  const hadWindow = 'window' in g;
  const store = new Map<string, string>([['injpad:wallet', 'leap']]);
  let asked = false;
  try {
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {},
        removeItem: () => {},
      },
    };
    /*
     * A provider that records being asked. `reconnectEvm` calls `eth_accounts`, so if
     * the EVM branch were taken this would flip - and the header would show a `0x`
     * account on a chain addressed by `inj1…`, which is the wrong-prefix hazard
     * `finishConnect` refuses at connect time.
     */
    g.ethereum = {
      request: () => {
        asked = true;
        return Promise.resolve(['0x1111111111111111111111111111111111111111']);
      },
    };
    const a = await wallet.reconnect();
    assert.equal(a, null, 'a CosmWasm build reconnected to something');
    assert.equal(asked, false, 'the EVM provider was asked on a CosmWasm build');
  } finally {
    if (!hadEth) delete g.ethereum;
    if (!hadWindow) delete g.window;
  }
});
