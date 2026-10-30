/**
 * Connecting an EVM wallet, through EIP-1193.
 *
 * SEPARATE FROM `wallet.ts` ON PURPOSE. That file speaks to Injective's native
 * wallets: it asks for a bech32 address, enables a Cosmos chain id and knows about
 * Keplr and Leap. None of that applies here. `wallet.ts` dispatches to these
 * functions so that the components above it keep one import, but the two paths do
 * not share an implementation, because there is nothing in common past the shape of
 * the account.
 *
 * The account shape IS shared, because everything above it - the trade panel, the
 * claim page, the header - only ever reads `address` and `name`. The address is a
 * `0x` string here where it is `inj1…` there, which is correct: on Injective those
 * are two encodings of one account, and the EVM side is addressed by the hex one.
 */
import { createWalletClient, custom, getAddress, type Address, type WalletClient } from 'viem';

import { NETWORK } from '../config.ts';
import {
  evmProvider,
  identifyEvmProvider,
  isUnrecognisedChain,
  isUserRejection,
  providerErrorText,
  type Eip1193,
} from './provider.ts';
import { evmChain } from './read.ts';

export { evmWalletAvailable, onEvmAccountChange } from './provider.ts';

/** How the chain id goes on the wire: hex, minimal digits, `0x` prefixed. */
function targetChainIdHex(): string {
  return `0x${Number(NETWORK.chainId).toString(16)}`;
}

/**
 * Ask the wallet to switch to Injective EVM, adding it if it does not know it.
 *
 * SIGNING ON THE WRONG CHAIN IS THE FAILURE TO PREVENT. A wallet left on Ethereum
 * would sign a transaction for a contract address that means nothing there, and the
 * user pays gas to find out. 4902 is the documented "unrecognised chain" code and
 * is the only case where offering to add it is the right response; any other error
 * is passed up, because a rejected switch must not be followed by a signature on
 * whatever chain the wallet was already on.
 */
export async function ensureEvmChain(p: Eip1193): Promise<void> {
  const target = targetChainIdHex();
  const current = (await p.request({ method: 'eth_chainId' })) as string;
  if (typeof current === 'string' && current.toLowerCase() === target.toLowerCase()) return;

  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
    return;
  } catch (e) {
    /*
     * `isUnrecognisedChain`, NOT `e.code === 4902`, and that one property cost a user
     * the whole connect flow. MetaMask on the live site answered the switch with
     *
     *     Unrecognized chain ID "0x6f0". Try adding the chain using
     *     wallet_switchEthereumChain first.
     *
     * and the code was not findable at `e.code`, so this rethrew and
     * `wallet_addEthereumChain` below was never called. The user was then shown "This
     * wallet could not add Injective EVM" about an add that never happened, with the
     * SWITCH's error underneath it as the evidence.
     */
    if (!isUnrecognisedChain(e)) throw e;
  }

  /*
   * THE REGISTRY'S OWN VALUES, not ours. chainid.network lists 1776 as `Injective`
   * with `https://blockscout.injective.network`; we call it "Injective EVM" in the
   * interface and link transactions to injscan, which are our choices to make about
   * our own UI and not about an entry in the user's wallet. MetaMask ships 1776 in
   * its network list, and an add whose name or explorer conflicts with its canonical
   * entry is a refusal we would have caused ourselves.
   *
   * `NETWORK.explorer` stays injscan for the links on this site. The two differ on
   * purpose, which is why the canonical values are written here rather than read from
   * the network config.
   */
  await p.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: target,
        chainName: 'Injective',
        nativeCurrency: evmChain().nativeCurrency,
        rpcUrls: [NETWORK.lcd],
        blockExplorerUrls: ['https://blockscout.injective.network'],
      },
    ],
  });

  /*
   * ADDING IS NOT SWITCHING, and some wallets do only the first. Re-reading is what
   * proves the chain actually changed; treating the add as success is how a
   * transaction gets signed on the chain the user was already on, which is the whole
   * thing this function exists to stop. Same reasoning as the Cosmos side retrying
   * `enable` after `experimentalSuggestChain` rather than assuming it took.
   */
  const after = (await p.request({ method: 'eth_chainId' })) as string;
  if (typeof after !== 'string' || after.toLowerCase() !== target.toLowerCase()) {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  }
}

/**
 * Checksum the address the wallet handed back.
 *
 * Wallets return lowercase, mixed case and checksummed forms interchangeably, and
 * the creator of a launch is compared against this string to decide whether to show
 * the claim button. A case difference would hide a creator's own fees from them, so
 * everything that leaves this module is in one canonical form. `getAddress` throws
 * on anything that is not an address, which is the validation as well.
 */
function canonical(raw: unknown): Address | null {
  if (typeof raw !== 'string') return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

export async function connectEvm(): Promise<Address> {
  const p = evmProvider();
  if (!p) throw new Error('No EVM wallet found in this browser.');

  let accounts: unknown;
  try {
    accounts = await p.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    const err = e as { code?: number; message?: string };
    // 4001 is EIP-1193's "user rejected request". A choice, not a fault, and
    // `wallet.ts` turns this marker into the sentence the user reads.
    if (err.code === 4001) throw new Error('rejected');
    throw new Error(
      `${err.message ?? String(e)}\n\nresponding provider at window.ethereum: ${identifyEvmProvider(p)}`,
    );
  }

  const first = Array.isArray(accounts) ? canonical(accounts[0]) : null;
  if (!first) throw new Error('The wallet connected but would not share an address.');

  /*
   * The chain is ensured AFTER the account, and the order matters: a locked wallet
   * answers neither, and asking for the chain first produces an error about networks
   * for what is really a locked extension.
   *
   * CLASSIFIED HERE, because it was not classified anywhere. This call sat outside the
   * try above, so everything it threw reached `wallet.ts` as a raw provider error - and
   * that file only recognises a rejection by the exact marker string this function
   * throws, never by a code. So a user who pressed Cancel on MetaMask's add-network
   * prompt was told their wallet could not add the network, which blames the wallet
   * for their decision.
   */
  try {
    await ensureEvmChain(p);
  } catch (e) {
    if (isUserRejection(e)) throw new Error('rejected');
    throw new Error(
      `could not switch to chain ${NETWORK.chainId}: ${providerErrorText(e) || String(e)}`,
    );
  }
  return first;
}

/**
 * The account the wallet has already granted, without prompting.
 *
 * `eth_accounts` rather than `eth_requestAccounts`: the first returns what has
 * already been approved and the second opens the wallet. Reconnecting on page load
 * must never open a dialog nobody asked for - the silent-reconnect requirement
 * `wallet.ts` records for `enable`.
 *
 * NO CHAIN SWITCH HERE EITHER, for the same reason: `wallet_switchEthereumChain`
 * prompts. The chain is ensured when the user acts, in `walletClient()`.
 */
export async function reconnectEvm(): Promise<Address | null> {
  const p = evmProvider();
  if (!p) return null;
  try {
    const accounts = await p.request({ method: 'eth_accounts' });
    return Array.isArray(accounts) ? canonical(accounts[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Which account the wallet is on NOW.
 *
 * The EVM half of `currentAccount`: switching account inside the extension must not
 * leave every screen describing the account the user just left. `null` when the
 * wallet will not answer or has no account granted, which is a disconnect.
 */
export async function currentEvmAccount(): Promise<Address | null> {
  return reconnectEvm();
}

/** A signing client, on the right chain, for the account the wallet is on. */
export async function walletClient(): Promise<{ client: WalletClient; account: Address }> {
  const p = evmProvider();
  if (!p) throw new Error('No EVM wallet found in this browser.');
  await ensureEvmChain(p);
  const account = await reconnectEvm();
  if (!account) throw new Error('The wallet has no connected account. Connect it and try again.');
  return {
    client: createWalletClient({ chain: evmChain(), transport: custom(p as never) }),
    account,
  };
}
