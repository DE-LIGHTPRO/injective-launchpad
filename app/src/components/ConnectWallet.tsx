'use client';

import { useCallback, useEffect, useState } from 'react';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<WalletName | null>(null);

  useDismissOnEscape(open, () => setOpen(false));

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
      setError(e instanceof WalletError ? e.message : 'The wallet could not be opened.');
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
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Connect wallet
      </button>

      {open && (
        <div className="wallet-menu" role="dialog" aria-label="Choose a wallet">
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

          {error && <p className="note danger-text">{error}</p>}
          <p className="note">
            Connecting shares your public address with this page. It signs nothing.
          </p>
        </div>
      )}
    </div>
  );
}
