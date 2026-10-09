/**
 * Which wallets this app can see, and the two ways that goes wrong silently.
 *
 * Both failure modes look identical to the user and identical to us: the wallet
 * simply is not offered. Neither throws, neither logs, and the person with the
 * extension installed concludes the site does not support it.
 *
 *   1. Looking in the wrong place. Cosmostation does not inject at
 *      `window.cosmostation`; its Keplr-compatible object is at
 *      `window.cosmostation.providers.keplr`. Assuming `window[name]` for every
 *      entry hides it from everyone who has it.
 *   2. Trusting presence over shape. Another extension's shim can occupy
 *      `window.keplr` with an object that has no `enable`. Offering that produces
 *      a "not a function" at the moment the user clicks, which reads as the app
 *      being broken rather than the wallet being absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED, available, type WalletName } from './wallet.ts';

/** Installs a fake extension at a dotted path, as the real ones do. */
function install(path: string, value: unknown) {
  const parts = path.split('.');
  let node = globalThis as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

const workingWallet = () => ({ enable: async () => {}, getKey: async () => ({ bech32Address: 'inj1x' }) });

function clearAll() {
  for (const w of SUPPORTED) {
    const root = w.globalKey.split('.')[0];
    delete (globalThis as unknown as Record<string, unknown>)[root];
  }
}

test('every supported wallet is detected at its own injection path', () => {
  /*
   * Driven from SUPPORTED rather than from a list written here, so a wallet added
   * later is covered without anyone remembering this file exists. If a new entry
   * injects somewhere unusual and `globalKey` is wrong, this fails immediately
   * instead of the wallet quietly never appearing.
   */
  clearAll();
  for (const w of SUPPORTED) {
    install(w.globalKey, workingWallet());
    assert.ok(
      available().includes(w.name),
      `${w.label} was not detected at ${w.globalKey}`,
    );
    clearAll();
  }
});

test('cosmostation is found under providers.keplr, not at the top level', () => {
  // The specific case that motivated the dotted path. Pinned on its own so a
  // "simplification" back to `window[name]` fails here with the reason attached.
  clearAll();
  const meta = SUPPORTED.find((w) => w.name === 'cosmostation')!;
  assert.equal(meta.globalKey, 'cosmostation.providers.keplr');

  // At the top level only: must NOT be detected, because that object is the
  // extension's own API and has no `enable`/`getKey`.
  install('cosmostation', { providers: {} });
  assert.ok(!available().includes('cosmostation'), 'detected a cosmostation with no keplr provider');

  install('cosmostation.providers.keplr', workingWallet());
  assert.ok(available().includes('cosmostation'));
  clearAll();
});

test('an object without the methods is not a wallet', () => {
  /*
   * Presence is not capability. A stub at `window.keplr` passes a null check and
   * fails at the click, which is strictly worse than not being listed: the user
   * has already chosen, and the error arrives as though the app broke.
   */
  clearAll();
  for (const stub of [{}, { enable: async () => {} }, { getKey: async () => ({}) }, { enable: 1, getKey: 2 }]) {
    install('keplr', stub);
    assert.ok(!available().includes('keplr'), `a stub was offered as a wallet: ${JSON.stringify(stub)}`);
  }
  install('keplr', workingWallet());
  assert.ok(available().includes('keplr'), 'a working wallet was rejected');
  clearAll();
});

test('nothing installed means nothing offered, and no throw', () => {
  // The common case on a fresh browser. It must return an empty list rather than
  // raising, because this runs during render.
  clearAll();
  assert.deepEqual(available(), []);
});

test('the order offered is stable and starts with the most common', () => {
  // Not cosmetic: the first row is the one most people click, and a list whose
  // order moves between renders is a list people misclick.
  const names: WalletName[] = SUPPORTED.map((w) => w.name);
  assert.equal(names[0], 'keplr');
  assert.equal(new Set(names).size, names.length, 'a wallet is listed twice');
  for (const w of SUPPORTED) {
    assert.match(w.install, /^https:\/\//, `${w.label} has no https install link`);
    assert.ok(w.label.trim().length > 0, `${w.name} has no label`);
  }
});

// ------------------------------------------------- connect failure handling --

import { connect } from './wallet.ts';

function installKeplr(behaviour: Partial<{ enable: () => Promise<void>; suggest: () => Promise<void> }>) {
  install('keplr', {
    enable: behaviour.enable ?? (async () => {}),
    getKey: async () => ({ bech32Address: 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqry8wy684', name: 'Acct' }),
    experimentalSuggestChain: behaviour.suggest,
  });
}

test('an unknown chain is asked for, not reported as misconfiguration', async () => {
  /*
   * The defect from the screenshot. Keplr was installed and the app said "The wallet
   * could not be opened." Keplr's build carried Injective mainnet and not the testnet,
   * so `enable('injective-888')` threw, and the code treated an unknown chain as the
   * app being misconfigured instead of calling the one method the extension provides
   * for exactly this.
   */
  clearAll();
  let suggested = 0;
  let enableCalls = 0;
  installKeplr({
    enable: async () => {
      enableCalls += 1;
      // Fails until the chain has been suggested, which is how Keplr behaves.
      if (suggested === 0) throw new Error('There is no chain info for injective-888');
    },
    suggest: async () => {
      suggested += 1;
    },
  });

  const account = await connect('keplr');
  assert.equal(suggested, 1, 'the chain was never suggested');
  assert.equal(enableCalls, 2, 'the connection was not retried after suggesting');
  assert.match(account.address, /^inj1/);
  // The provider is carried so signing uses this extension rather than a re-lookup.
  assert.ok(account.provider, 'the account did not carry its provider');
  clearAll();
});

test('suggesting is retried, never assumed to have worked', async () => {
  // Treating `suggestChain` as success without re-enabling would report a connection
  // that never happened, and the next action would fail with no wallet behind it.
  clearAll();
  installKeplr({
    enable: async () => {
      throw new Error('There is no chain info for injective-888');
    },
    suggest: async () => {},
  });
  await assert.rejects(connect('keplr'), /could not add|does not know/);
  clearAll();
});

test('declining the add prompt is a choice, not a fault', async () => {
  clearAll();
  installKeplr({
    enable: async () => {
      throw new Error('There is no chain info for injective-888');
    },
    suggest: async () => {
      throw new Error('Request rejected');
    },
  });
  await assert.rejects(connect('keplr'), /declined adding/);
  clearAll();
});

test('an unrecognised failure keeps the wallet"s own words', async () => {
  /*
   * The part that made this undiagnosable. Extensions throw strings, plain objects and
   * Errors interchangeably, and `(e as Error).message` is undefined for two of the
   * three, so every unexpected failure collapsed into one generic sentence with
   * nothing behind it.
   */
  for (const thrown of [
    new Error('keystore is locked'),
    'keystore is locked',
    { message: 'keystore is locked' },
    { error: 'keystore is locked' },
  ]) {
    clearAll();
    installKeplr({
      enable: async () => {
        throw thrown;
      },
    });
    await assert.rejects(connect('keplr'), (e: unknown) => {
      const w = e as { detail?: string; message: string };
      assert.ok(
        w.detail?.includes('keystore is locked'),
        `the wallet's words were lost for ${typeof thrown}: ${w.detail}`,
      );
      return true;
    });
  }
  clearAll();
});

test('a locked wallet says to unlock it, in whichever words the extension used', async () => {
  /*
   * The most common cause of a failed connect, and it was landing in the catch-all.
   * Each wallet phrases it differently and none of the phrasings matched anything:
   * Keplr says "Key ring is not unlocked", Leap says "wallet is locked". The
   * instruction the user needs was buried behind a disclosure in both cases.
   */
  for (const words of [
    'Key ring is not unlocked',
    'keyring is locked',
    'The wallet is locked',
    'no account found in keyring',
  ]) {
    clearAll();
    installKeplr({
      enable: async () => {
        throw new Error(words);
      },
    });
    await assert.rejects(connect('keplr'), (e: unknown) => {
      const w = e as { message: string; detail?: string };
      assert.match(w.message, /locked/i, `"${words}" did not produce an unlock instruction`);
      assert.ok(w.detail?.includes(words), 'the extension\'s own words were lost');
      return true;
    });
  }
  clearAll();
});

test('a cancelled prompt reads as a choice, however it is spelled', async () => {
  // "cancelled" and "canceled" are both in the wild, and neither matched before.
  for (const words of ['Request rejected', 'User cancelled', 'Request canceled by user']) {
    clearAll();
    installKeplr({
      enable: async () => {
        throw new Error(words);
      },
    });
    await assert.rejects(connect('keplr'), /closed the wallet prompt/);
  }
  clearAll();
});
