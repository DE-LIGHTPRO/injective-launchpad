/**
 * Finding the injected EVM provider, and nothing else.
 *
 * ITS OWN MODULE BECAUSE IT HAS TO BE CHEAP. `wallet.ts` asks whether an EVM wallet
 * is present from `available()`, which is synchronous and runs on every render of
 * the connect button, so it cannot be a dynamic import. Everything else on the EVM
 * path pulls in viem, which is not something to load on a page where the user may
 * never connect. Splitting the detection out keeps one copy of it: the alternative
 * was a second inline `window.ethereum` check in `wallet.ts`, which is the
 * two-places-one-decision shape this project keeps recording.
 */

/** The subset of EIP-1193 this app uses, declared rather than imported from viem. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * The injected provider, or null.
 *
 * Read at call time, never cached. An extension injects itself during page load, so
 * a value captured at module evaluation can be null on a page where the wallet is
 * in fact installed - the same race `wallet.ts` records for the Cosmos extensions,
 * and it reads to the user as "no wallet" in exactly the same way.
 *
 * Checked for `request`, not just for presence: a page can carry a stub on
 * `window.ethereum` (another extension's shim, a leftover from a harness), and
 * offering it produces a "not a function" at the moment the user clicks, which
 * reads as the app being broken rather than the wallet being absent.
 */
export function evmProvider(): Eip1193 | null {
  if (typeof globalThis === 'undefined') return null;
  const w = globalThis as unknown as { ethereum?: unknown };
  const cand = w.ethereum;
  if (cand === null || typeof cand !== 'object') return null;
  return typeof (cand as Eip1193).request === 'function' ? (cand as Eip1193) : null;
}

export function evmWalletAvailable(): boolean {
  return evmProvider() !== null;
}

/**
 * Which extension answered, for an error detail.
 *
 * `window.ethereum` is not reserved and several wallets compete for it, so a
 * failure should name the extension that produced it rather than the one the user
 * thought they clicked. Same reasoning as `identify` on the Cosmos side.
 */
export function identifyEvmProvider(p: Eip1193): string {
  const o = p as unknown as Record<string, unknown>;
  const flags = [
    'isMetaMask',
    'isRabby',
    'isBraveWallet',
    'isTrust',
    'isCoinbaseWallet',
    'isOkxWallet',
    'isPhantom',
  ].filter((f) => o[f] === true);
  return flags.join(', ') || 'unidentified';
}

/**
 * Account and chain changes.
 *
 * HERE RATHER THAN IN `evm/wallet.ts` because `wallet.ts` binds listeners
 * synchronously, from an effect, and must not pull viem into a page where nobody
 * ever connects. This needs only the provider.
 *
 * `chainChanged` is bound as well as `accountsChanged`: a user switching network in
 * the wallet is the case `ensureEvmChain` exists for, and the header should re-read
 * rather than keep showing a balance from the chain they left.
 */
export function onEvmAccountChange(cb: () => void): () => void {
  const p = evmProvider();
  if (!p?.on) return () => {};
  const handler = () => cb();
  p.on('accountsChanged', handler);
  p.on('chainChanged', handler);
  return () => {
    p.removeListener?.('accountsChanged', handler);
    p.removeListener?.('chainChanged', handler);
  };
}
