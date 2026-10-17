'use client';

import { useEffect, useState } from 'react';
import type { WalletAccount } from './wallet';

/**
 * The connected account, shared between components that cannot see each other.
 *
 * `ConnectWallet` lives in the layout and `TradePanel` on a server-rendered page, so
 * there is no common client ancestor to hang a context provider from without turning
 * the whole tree into a client component. A module-level value with subscribers is the
 * smaller answer: it costs no provider, no re-render of the server tree, and it is the
 * same object either side.
 *
 * Not persisted. A page load with a remembered address but no live extension session
 * would show a connected wallet whose every action fails, which is worse than asking
 * someone to click connect again.
 */
let current: WalletAccount | null = null;
const listeners = new Set<(a: WalletAccount | null) => void>();

export function setConnectedAccount(a: WalletAccount | null): void {
  current = a;
  for (const fn of listeners) fn(a);
}

export function useConnectedAccount(): WalletAccount | null {
  /*
   * Seeded with null rather than `current`, then synced in an effect. Seeding with the
   * live value would make the server render and the first client render disagree
   * whenever a wallet is already connected, which React reports as a hydration error
   * and which blanks the panel it happens in.
   */
  const [account, setAccount] = useState<WalletAccount | null>(null);
  useEffect(() => {
    setAccount(current);
    listeners.add(setAccount);
    return () => {
      listeners.delete(setAccount);
    };
  }, []);
  return account;
}
