'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  available,
  connect,
  currentAccount,
  onAccountChange,
  reconnect,
  rememberWallet,
  quoteBalance,
  shortAddress,
  walletOptions,
  WalletError,
  type WalletAccount,
  type WalletName,
} from '@/lib/wallet';
import { fmt } from '@/lib/curve';
import { SignOutIcon } from './Icons';
import { NETWORK } from '@/lib/config';
import { useDismissOnEscape } from '@/lib/useDismissOnEscape';
import { setConnectedAccount } from '@/lib/walletStore';

/**
 * Connect, and show which account is connected.
 *
 * The list is built from what is actually installed, read on mount rather than
 * at import: an extension injects itself during page load, so a value captured
 * when the module evaluates can be empty on a page where the wallet is in fact
 * present. That race reads to the user as "no wallet".
 *
 * Nothing here signs. The button hands an address to the rest of the page and
 * stops; see `createLaunch.ts` for why the transaction builder is separate and
 * tested as data.
 */
export function ConnectWallet({
  onAccount,
}: {
  onAccount?: (a: WalletAccount | null) => void;
}) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [installed, setInstalled] = useState<WalletName[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string; expand?: boolean } | null>(null);
  const [busy, setBusy] = useState<WalletName | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Distinguishes a close from the first render, which look identical from `open` alone.
  const everOpened = useRef(false);

  useDismissOnEscape(open, () => setOpen(false), '.wallet');

  /*
   * Focus follows the menu, and comes back when it closes.
   *
   * This carried `role="dialog"` with a label, and focus never entered it: the
   * active element stayed on the body, with no trap and no restore. That is worse
   * than a plain dropdown, because assistive technology announces a dialog while
   * the user's focus is still out on the page with no obvious way in. It is a
   * lightweight popover, so it is no longer called a dialog, and focus moves to
   * the first thing in it on open and returns to the trigger on close, which is
   * what a keyboard user expects of a menu either way.
   */
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      const first = menuRef.current?.querySelector<HTMLElement>('button, a');
      first?.focus();
      return;
    }
    /*
     * ONLY AFTER A CLOSE, which the first version did not check - and so it ran on
     * MOUNT, where `open` is false and the active element is the body, and focused
     * the Connect button on every cold page load. Measured on /portfolio: with no
     * wallet connected and nothing clicked, `document.activeElement` was this
     * trigger the moment the page settled. That puts a keyboard user past the skip
     * link before their first Tab, and drops a screen reader into the header
     * instead of at the top of the document, on every page.
     */
    if (!everOpened.current) return;
    everOpened.current = false;
    /*
     * Restored when focus was LOST, which is the only signal available here.
     *
     * An earlier version asked whether the active element was still inside the
     * menu. That can never be true: by the time this effect runs the menu has
     * unmounted, `menuRef.current` is null, and the check is unreachable. Focus
     * restore simply never happened, and Escape left the user on the body.
     *
     * Removing a focused node drops focus to the body, so a body or null active
     * element after a close means the thing the user was on has just gone. That
     * is the case to restore. Anything else means they have moved on themselves,
     * and pulling focus back from there would be its own bug.
     */
    const a = document.activeElement;
    if (!a || a === document.body) triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    /*
     * Polled briefly rather than read once. Both extensions set their global
     * during page load and the timing is not ours to control, so a single read on
     * mount is a coin flip on a cold load.
     */
    let tries = 0;
    const tick = () => {
      const found = available();
      if (found.length > 0 || tries > 10) {
        setInstalled(found);
        return;
      }
      tries += 1;
      window.setTimeout(tick, 150);
    };
    tick();
  }, []);

  /*
   * RESTORE THE SESSION ON LOAD, which is why only the wallet's NAME is remembered.
   * A reload used to drop the connection entirely: the header showed Connect, and a
   * creator who had just signed something had to reconnect to see their own page.
   *
   * `enable` does not prompt again for a chain the extension has already approved,
   * so this is silent; if approval was revoked, the wallet is locked, or it is gone,
   * `reconnect` returns null and the header shows Connect, which is the truth.
   *
   * Deliberately NOT awaited before the first paint. A wallet extension that is slow
   * or absent must not hold the header, and the connected state arriving a moment
   * later is the normal shape of this on every dapp.
   */
  useEffect(() => {
    let live = true;
    void reconnect().then((a) => {
      if (live && a) setAccount(a);
    });
    return () => {
      live = false;
    };
  }, []);

  /*
   * FOLLOW THE WALLET WHEN IT SWITCHES ACCOUNT. Audit F-18: the address was read once
   * at connect and never again, so switching inside the extension left every screen
   * describing the account the user had just left, with nothing saying so.
   *
   * `currentAccount` returns the SAME object when nothing changed, so `setAccount` is a
   * no-op for React and the effects keyed on `account` below do not re-fire. That
   * matters because this is bound to `focus` as well as to the wallets' own events, for
   * the reason given on `KEYSTORE_EVENTS`, and a new object per focus would re-request
   * balances and the purchased-so-far read every time the user clicked back into the
   * window.
   *
   * Coalesced on a ref rather than on state: focus and a keystore event arrive together
   * when the user comes back from the popup, and two overlapping reads could land out of
   * order and set the older answer.
   */
  const rereading = useRef(false);
  useEffect(() => {
    if (!account) return;
    const check = () => {
      if (rereading.current) return;
      rereading.current = true;
      void currentAccount(account)
        .then((a) => {
          /*
           * `null` is a locked wallet or a revoked approval, which is a disconnect and
           * has to be shown as one. The remembered wallet NAME is deliberately kept:
           * this is not the user pressing Disconnect, it is the extension locking, and
           * forgetting the name would stop the next reload restoring the session.
           */
          setAccount(a);
        })
        .finally(() => {
          rereading.current = false;
        });
    };
    return onAccountChange(check);
  }, [account]);

  useEffect(() => {
    onAccount?.(account);
    // Published for components that have no ancestor in common with this one, which
    // is every panel on a server-rendered page. See `walletStore`.
    setConnectedAccount(account);
    if (!account) {
      setBalance(null);
      return;
    }
    let live = true;
    void quoteBalance(account.address).then((b) => {
      if (live) setBalance(b);
    });
    return () => {
      live = false;
    };
  }, [account, onAccount]);

  const pick = useCallback(async (name: WalletName) => {
    setError(null);
    setBusy(name);
    try {
      setAccount(await connect(name));
      // Which wallet, so a reload can re-establish the session. Never the address.
      rememberWallet(name);
      setOpen(false);
    } catch (e) {
      // The wallet's own words are for integrators. These are written for the
      // person who just clicked, and a rejection is a choice rather than a fault.
      /*
       * The extension's own words are kept alongside the translated sentence rather
       * than replacing it or being thrown away. Thrown away is what the first version
       * did, and a real Keplr failure then showed "The wallet could not be opened."
       * with nothing behind it: nothing for the user to act on and nothing for me to
       * diagnose from.
       */
      if (e instanceof WalletError) {
        /*
         * An UNRECOGNISED failure opens its detail by default, and that is the whole
         * point of keeping it. When the sentence above is a real translation the raw
         * text adds nothing and stays folded; when it is the catch-all, the raw text
         * is the only thing that identifies the problem, and hiding it behind a click
         * means nobody reads it, including me.
         */
        setError({ message: e.message, detail: e.detail, expand: e.kind === 'failed' });
      } else {
        setError({ message: 'The wallet did not open.', detail: String(e), expand: true });
      }
    } finally {
      setBusy(null);
    }
  }, []);

  if (account) {
    return (
      <div className="wallet">
        {/* The address alone, because it is the thing that identifies which account
            will sign. The extension's own name for the account used to sit above it
            and is gone: see the note on `WalletAccount`. */}
        <span className="mono wallet-addr">{shortAddress(account.address)}</span>
        <span className="wallet-bal mono">
          {/*
              `null` is "not read", never zero. A fresh account that has never
              been funded does not exist on chain, and showing it as 0 INJ would
              be a claim about a balance nobody has looked up.
            */}
          {balance === null ? 'balance not read' : `${fmt(balance, NETWORK.quoteDecimals, 3)} ${NETWORK.quoteSymbol}`}
        </span>
        <button
          type="button"
          className="ghost"
          /*
           * THE WORD GOES ON A PHONE AND THE ICON STAYS. Audit F-14 and F-15, which are
           * one defect: the connected cluster does not fit a 375px header.
           *
           * Measured at 375x812 with the connected markup in place: brand 26, the mobile
           * nav 36, Create 91, and the cluster's own children 90 + 10 + 97 = 197, which
           * is 382 against 343px of content room. `.wallet` carries `min-width: 0`, so
           * it does not refuse - it shrinks to 142 while its `white-space: nowrap`
           * children keep their width and spill out of it, pushing the document to 414.
           * 39px of sideways scroll on every page, in the one state a trader is in.
           *
           * THE ADDRESS IS THE PART THAT CANNOT GO. It is the only thing on the screen
           * that says which account is about to sign, which is the whole point of the
           * F-18 work. Dropping it would save 100px and lose the safety-critical half.
           * Shedding the label saves 61, which closes a 39px gap with room to spare, and
           * it is the next rung on a ladder this header already climbs: the balance goes
           * at 1100px, the network and demo chips at 640px, both for this exact reason.
           *
           * `aria-label` is unconditional so the control has a name in both states, and
           * "Disconnect" is a subset of it, which is what WCAG 2.5.3 asks for.
           */
          aria-label="Disconnect wallet"
          onClick={() => {
            // Forgetting is the point of the button: without this a reload would
            // silently reconnect the wallet the user just disconnected.
            rememberWallet(null);
            setAccount(null);
          }}
        >
          <SignOutIcon size={14} />
          <span className="hide-sm">Disconnect</span>
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
      >
        Connect wallet
      </button>

      {open && (
        <div ref={menuRef} id={menuId} className="wallet-menu" aria-label="Choose a wallet">
          {installed === null && <p className="note">Looking for a wallet…</p>}

          {installed !== null && installed.length === 0 && (
            <>
              {/*
                  The list comes from `walletOptions()`, which is backend-aware: five
                  Cosmos extensions on a CosmWasm build, one EIP-1193 row on an EVM
                  one. Offering Keplr on an EVM deployment would name a wallet that
                  cannot sign anything this factory accepts.
                */}
              <p className="note">
                No wallet found in this browser that can sign on {NETWORK.label}. Install one
                of these, then reload.
              </p>
              <ul className="wallet-list">
                {walletOptions().map((w) => (
                  <li key={w.name}>
                    <a href={w.install} target="_blank" rel="noopener noreferrer">
                      {w.label}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}

          {installed !== null && installed.length > 0 && (
            <ul className="wallet-list">
              {walletOptions()
                .filter((w) => installed.includes(w.name))
                .map((w) => (
                  <li key={w.name}>
                    <button type="button" disabled={busy !== null} onClick={() => void pick(w.name)}>
                      {busy === w.name ? `Opening ${w.label}…` : w.label}
                    </button>
                  </li>
                ))}
            </ul>
          )}

          {error && (
            <>
              <p className="note danger-text">{error.message}</p>
              {/*
                  Actionable, and only when it is. With five wallets offered, trying a
                  different one is the fastest way past the common cause: several
                  extensions offer to become the default Cosmos wallet and overwrite
                  `window.keplr`, so the button says one name and another extension
                  answers. Ninji is Injective's own, so it is the one most likely to
                  already know this chain.
                */}
              {error.expand && installed && installed.length > 1 && (
                <p className="note">
                  Another wallet in this list may work: extensions can take over each
                  other&rsquo;s connection point, so the name on the button is not always
                  the one that answers.
                </p>
              )}
              {error.detail && (
                /*
                 * Behind a disclosure, not in the sentence. An extension's error text
                 * is written for an integrator and reads as a crash, but it is the
                 * only thing that identifies an unexpected failure, so it is one click
                 * away rather than gone.
                 */
                <details className="raw" open={error.expand}>
                  <summary>What the wallet said</summary>
                  {/* Focusable because it scrolls: see `.raw pre:focus-visible`. */}
                  <pre tabIndex={0}>{error.detail}</pre>
                </details>
              )}
            </>
          )}
          <p className="note">
            Connecting shares your public address with this page. It signs nothing.
          </p>
        </div>
      )}
    </div>
  );
}
