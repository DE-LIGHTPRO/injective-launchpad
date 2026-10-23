/**
 * THE ADDRESS WAS READ ONCE AT CONNECT AND NEVER AGAIN.
 *
 * Audit F-18. Switching account inside the wallet left every screen describing the
 * account the user had just left: the header balance, the portfolio, a creator's
 * claimable fees, the opening-buy cap, the "already created" check on the create page.
 * Nothing on the page said so, and a holder reading their own position was reading
 * somebody else's - the one failure a balance must not have, because an omitted
 * position and a sold one look identical.
 *
 * TWO HALVES, and the second is the one that reaches a wallet prompt.
 *
 *  - `currentAccount` re-reads the key from the extension the user actually connected
 *    to, and `onAccountChange` says when to.
 *  - `signAndBroadcast` refuses when the extension is on a different account than the
 *    transaction was prepared for. The messages, the sender, the sequence and the fee
 *    are all built for the address the page was showing, while the pubkey is read at
 *    signing time, so a switch in between puts one account's pubkey in the other's
 *    authInfo. No funds are at risk - a transaction that fails signature verification
 *    never enters a block and costs no gas - which is exactly why it is worth refusing
 *    instead of attempting: what it costs otherwise is a prompt the user approves and
 *    an error about an account they can no longer see.
 *
 * WHAT CANNOT BE VERIFIED FROM HERE is which event name each of the five wallets
 * emits, and the implementation is built so that does not matter: `focus` and
 * `visibilitychange` are the mechanism and the event names are the fast path. Switching
 * account happens in an extension popup or another tab, so coming back to the page is
 * the one thing that always follows, whatever the wallet chose to emit. These tests pin
 * that both are bound, because a build that bound only the event names would pass a
 * Keplr check by hand and silently do nothing in the next wallet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { currentAccount, onAccountChange, type WalletAccount } from './wallet.ts';
import { maskComments } from './testing/maskComments.ts';

const A = 'inj1fhqyssaa2hm693v9qtnreu4mcrwvfy6myg742p';
const B = 'inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl';

/** A connected account whose provider answers with whatever this test wants. */
function connected(answer: (() => Promise<{ bech32Address: string }>) | null): WalletAccount {
  return {
    name: 'keplr',
    address: A,
    provider: answer === null ? {} : { getKey: answer },
  } as WalletAccount;
}

test('an unchanged account returns the same object, so nothing keyed on it re-fires', async () => {
  /*
   * REFERENCE IDENTITY IS THE ASSERTION, not equality of the address. A keystore event
   * fires for renaming an account and for approving a chain too, and this is bound to
   * `focus` as well, so a fresh object per event would re-request balances and the
   * purchased-so-far read every time the user clicked back into the window. Unchanged
   * has to be indistinguishable from no event at all.
   */
  const account = connected(async () => ({ bech32Address: A }));
  assert.equal(await currentAccount(account), account);
});

test('a switched account returns the new address', async () => {
  const account = connected(async () => ({ bech32Address: B }));
  const next = await currentAccount(account);
  assert.notEqual(next, null);
  assert.equal(next?.address, B);
  /* Everything else is carried, including the provider: the extension has not changed. */
  assert.equal(next?.name, account.name);
  assert.equal(next?.provider, account.provider);
});

test('a wallet that will not answer is a disconnect, not a stale address', async () => {
  /*
   * A locked wallet and a revoked approval both throw here, and both mean the session
   * is over. Keeping the old address would leave the header showing a connected
   * account whose every action fails, which is the state `walletStore` declines to
   * persist for the same reason.
   */
  const thrown = connected(async () => {
    throw new Error('Keplr is locked');
  });
  assert.equal(await currentAccount(thrown), null);
});

test('an address that is not Injective is a disconnect, never shown as theirs', async () => {
  /*
   * A wallet pointed at another Cosmos chain answers with that chain's prefix. Funds
   * sent from or to it go somewhere the user did not mean, which is why `finishConnect`
   * refuses the same thing at connect time - a re-read must not be the way around it.
   */
  for (const addr of ['osmo1fhqyssaa2hm693v9qtnreu4mcrwvfy6mabcdef', 'inj1short', '', 'INJ1UPPER']) {
    assert.equal(await currentAccount(connected(async () => ({ bech32Address: addr }))), null, addr);
  }
});

test('a provider that cannot be asked is unchanged, not logged out', async () => {
  /*
   * Every connected account came through `finishConnect`, which calls `getKey`, so this
   * cannot happen for one of ours. Inventing a disconnect from a shape we do not
   * recognise would log someone out of a working session, which is the worse direction.
   */
  const account = connected(null);
  assert.equal(await currentAccount(account), account);
});

/** Records every listener bound and unbound, standing in for a browser. */
function stubBrowser() {
  const bound: [string, unknown][] = [];
  const unbound: [string, unknown][] = [];
  const target = (store: 'win' | 'doc') => ({
    addEventListener: (n: string, f: unknown) => bound.push([`${store}:${n}`, f]),
    removeEventListener: (n: string, f: unknown) => unbound.push([`${store}:${n}`, f]),
  });
  const g = globalThis as Record<string, unknown>;
  const had = { window: g.window, document: g.document };
  g.window = target('win');
  g.document = { ...target('doc'), visibilityState: 'visible' };
  return {
    bound,
    unbound,
    restore: () => {
      g.window = had.window;
      g.document = had.document;
    },
  };
}

test('the re-read is bound to the wallets\u2019 events AND to coming back to the page', () => {
  const b = stubBrowser();
  try {
    const cb = () => {};
    const off = onAccountChange(cb);

    const names = b.bound.map(([n]) => n);
    for (const w of ['keplr', 'leap', 'cosmostation', 'owallet', 'ninji']) {
      assert.ok(names.includes(`win:${w}_keystorechange`), `${w} does not announce a switch to us`);
    }
    /*
     * The half that makes a wrong event name survivable. A wallet that emits nothing we
     * recognise still updates the moment the user looks at the page, and a build that
     * bound only the five names above would pass a Keplr check by hand and do nothing
     * in the next wallet.
     */
    assert.ok(names.includes('win:focus'), 'returning from the extension popup does not re-read');
    assert.ok(names.includes('doc:visibilitychange'), 'returning from another tab does not re-read');

    /*
     * And unbound by the SAME references. `visibilitychange` is wrapped in a local
     * closure, so removing a freshly made one would leave the listener attached to a
     * component that has unmounted: a leak that only shows up as a dead setState.
     */
    off();
    assert.deepEqual(
      b.unbound.map(([n]) => n).sort(),
      b.bound.map(([n]) => n).sort(),
      'something bound is not unbound',
    );
    for (const [name, fn] of b.bound) {
      assert.ok(
        b.unbound.some(([n, f]) => n === name && f === fn),
        `${name} is removed with a different function than it was added with`,
      );
    }
  } finally {
    b.restore();
  }
});

test('the signing path refuses a switched account BEFORE the wallet prompt', () => {
  /*
   * A source guard, because `signAndBroadcast` is not exported and the thing being
   * asserted is an ORDER: the comparison has to sit between reading the key and asking
   * the extension to sign. Checking afterwards would be a prompt the user approves and
   * a failure they cannot explain, which is the whole defect.
   *
   * Anchored on `offline.signDirect`, which is what it measures, rather than on the
   * first occurrence of some common token - the mistake that emptied a slice in
   * `cctp-speed-toggle` once a second try/catch appeared above it.
   */
  const src = maskComments(readFileSync(new URL('./broadcast.ts', import.meta.url), 'utf8'));
  const read = src.indexOf('await signer.getKey(');
  const guard = src.indexOf('key.bech32Address !== opts.sender');
  const prompt = src.indexOf('offline.signDirect(');
  assert.ok(read > 0, 'the key is no longer read from the extension at signing time');
  assert.ok(prompt > 0, 'the signing call moved, so this test is measuring nothing');
  assert.ok(guard > read, 'the sender is compared against a key that has not been read yet');
  assert.ok(guard < prompt, 'the switched account is caught after the user has already approved');
  assert.match(src, /'wrong-account'/, 'the refusal is not distinguishable from any other failure');
  assert.match(
    src,
    /Nothing was signed\./,
    'the message does not say the one thing a user needs to hear first',
  );
});

test('the header follows the wallet, and a lock does not forget which wallet it was', () => {
  const src = maskComments(
    readFileSync(new URL('../components/ConnectWallet.tsx', import.meta.url), 'utf8'),
  );

  /* Rule 52 again: the re-read exists and something reaches it. */
  assert.match(src, /currentAccount\(account\)/, 'nothing re-reads the connected account');

  /*
   * Returned from the effect, so the listeners come off on unmount, and keyed on
   * `account` so the closure is never re-reading a stale one.
   */
  assert.match(
    src,
    /return onAccountChange\(check\);\s*\}, \[account\]\)/,
    'the listeners are not unbound on unmount, or the closure holds a stale account',
  );

  /*
   * `rememberWallet(null)` belongs to the Disconnect button and nowhere else. A wallet
   * locking is not the user disconnecting, and forgetting the name there would stop the
   * next reload restoring a session the user never ended.
   */
  assert.equal(
    src.match(/rememberWallet\(null\)/g)?.length,
    1,
    'a locked wallet now forgets the session, or Disconnect no longer clears it',
  );
});
