'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  available,
  connect,
  quoteBalance,
  shortAddress,
  SUPPORTED,
  WalletError,
  type WalletAccount,
  type WalletName,
} from '@/lib/wallet';
import { fmt } from '@/lib/curve';
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
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState<WalletName | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useDismissOnEscape(open, () => setOpen(false));

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
      const first = menuRef.current?.querySelector<HTMLElement>('button, a');
      first?.focus();
      return;
    }
    /*
     * Restored when focus was LOST, which is the only signal available here.
     *
     * The first version asked whether the active element was still inside the
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
        setError({ message: e.message, detail: e.detail });
      } else {
        setError({ message: 'The wallet did not open.', detail: String(e) });
      }
    } finally {
      setBusy(null);
    }
  }, []);

  if (account) {
    return (
      <div className="wallet">
        <span className="wallet-acct">
          <span className="wallet-name">{account.label}</span>
          <span className="mono wallet-addr">{shortAddress(account.address)}</span>
        </span>
        <span className="wallet-bal mono">
          {/*
              `null` is "not read", never zero. A fresh account that has never
              been funded does not exist on chain, and showing it as 0 INJ would
              be a claim about a balance nobody has looked up.
            */}
          {balance === null ? 'balance not read' : `${fmt(balance, NETWORK.quoteDecimals, 3)} ${NETWORK.quoteSymbol}`}
        </span>
        <button type="button" className="ghost" onClick={() => setAccount(null)}>
          Disconnect
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
              <p className="note">
                No Injective wallet found in this browser. Install one of these, then reload.
              </p>
              <ul className="wallet-list">
                {SUPPORTED.map((w) => (
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
              {SUPPORTED.filter((w) => installed.includes(w.name)).map((w) => (
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
              {error.detail && (
                /*
                 * Behind a disclosure, not in the sentence. An extension's error text
                 * is written for an integrator and reads as a crash, but it is the
                 * only thing that identifies an unexpected failure, so it is one click
                 * away rather than gone.
                 */
                <details className="raw">
                  <summary>What the wallet said</summary>
                  <pre>{error.detail}</pre>
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
