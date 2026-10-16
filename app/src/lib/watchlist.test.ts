import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWatchlist, readWatchlist, toggleWatch } from './watchlist.ts';

/**
 * A fake browser, because the thing under test is WHICH KEY gets written.
 *
 * The defect these cover: the list was stored under a flat `injpad:watchlist:v1`,
 * while mainnet is a flip of `NEXT_PUBLIC_NETWORK` on the same origin. Launch ids
 * restart at 1 under a new factory, so on launch day a visitor's starred testnet ids
 * would have resolved against mainnet launches numbered the same, and the page would
 * have shown a curated-looking list of tokens they had never looked at.
 *
 * A fixture of one stored value cannot reach that. The scope has to be observed.
 */
function fakeBrowser(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const prev = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: () => true,
  };
  return {
    store,
    restore: () => {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    },
  };
}

function withFactory<T>(address: string, fn: () => T): T {
  const prev = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = address;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    else process.env.NEXT_PUBLIC_FACTORY_ADDRESS = prev;
  }
}

test('a stored watchlist parses to unique positive integer ids', () => {
  assert.deepEqual(parseWatchlist('[3, 1, 3, "x", -2, 1.5, 7]'), [3, 1, 7]);
});

test('anything that is not a list reads as empty, never as a crash', () => {
  for (const raw of [null, '', 'not json', '{"a":1}', '42']) {
    assert.deepEqual(parseWatchlist(raw), []);
  }
});

test('a corrupted, enormous list is capped', () => {
  const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => i + 1));
  assert.equal(parseWatchlist(big).length, 500);
});

test('the list is stored under the factory it was starred against', () => {
  const b = fakeBrowser();
  try {
    withFactory('inj1factoryA', () => toggleWatch(7));
    assert.deepEqual([...b.store.keys()], ['injpad:watchlist:v1:inj1factoryA']);
    assert.deepEqual(withFactory('inj1factoryA', readWatchlist), [7]);
  } finally {
    b.restore();
  }
});

test('a different factory reads an empty list, not the other one', () => {
  /*
   * The launch-day case. Same browser, same origin, new factory: the ids in there
   * belong to launches that no longer exist and numbers that now mean other tokens.
   */
  const b = fakeBrowser();
  try {
    withFactory('inj1testnetfactory', () => toggleWatch(1));
    withFactory('inj1testnetfactory', () => toggleWatch(2));
    assert.deepEqual(withFactory('inj1mainnetfactory', readWatchlist), []);
    // And the testnet list is still intact for anyone who switches back.
    assert.deepEqual(withFactory('inj1testnetfactory', readWatchlist), [2, 1]);
  } finally {
    b.restore();
  }
});

test('an unscoped legacy list is dropped rather than adopted', () => {
  /*
   * The tempting migration is the bug: there is no record of which factory wrote the
   * flat key, so adopting it into the current scope is exactly the cross-network
   * carry-over this scoping exists to stop. It is removed so nothing can re-adopt it.
   */
  const b = fakeBrowser({ 'injpad:watchlist:v1': '[4,5,6]' });
  try {
    assert.deepEqual(withFactory('inj1factoryA', readWatchlist), []);
    assert.ok(!b.store.has('injpad:watchlist:v1'), 'the legacy key is still there');
  } finally {
    b.restore();
  }
});

test('no factory configured still reads and writes without throwing', () => {
  const b = fakeBrowser();
  try {
    withFactory('', () => toggleWatch(3));
    assert.deepEqual([...b.store.keys()], ['injpad:watchlist:v1:none']);
    assert.deepEqual(withFactory('', readWatchlist), [3]);
  } finally {
    b.restore();
  }
});

test('storage that throws reads as an empty list', () => {
  const prev = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: () => {
        throw new Error('site data blocked');
      },
      setItem: () => {
        throw new Error('site data blocked');
      },
      removeItem: () => {
        throw new Error('site data blocked');
      },
    },
    dispatchEvent: () => true,
  };
  try {
    assert.deepEqual(withFactory('inj1factoryA', readWatchlist), []);
    // The toggle must still report the new state so the star flips in this tab.
    assert.equal(withFactory('inj1factoryA', () => toggleWatch(9)), true);
  } finally {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prev;
  }
});
