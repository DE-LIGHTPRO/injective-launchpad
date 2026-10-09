import { NETWORK, getLcdUrl } from './config.ts';

/**
 * Wallet connection, over the extensions' own injected API.
 *
 * No SDK. Keplr and Leap both expose the same small surface on `window`
 * (`enable`, `getKey`), which is all that connecting and reading an address
 * needs, and the balance comes from the LCD this app already talks to. That
 * keeps the dependency count at zero for everything up to signing.
 *
 * SIGNING IS DELIBERATELY NOT HERE. Broadcasting on Injective means building
 * protobuf messages, and a launch needs three of them: MsgCreateDenom and
 * MsgMint from Injective's tokenfactory module, then the CosmWasm execute with
 * the entire token supply attached. That is a real dependency and, more to the
 * point, a path I cannot exercise without an extension installed. This codebase
 * has already recorded what happens when a transaction builder ships unexercised:
 * a v3 quote that produced calldata the router could not answer, and a deposit
 * address that needed a contract call rather than a transfer. So the messages are
 * built and tested as data in `createLaunch.ts`, shown to the user before
 * anything is signed, and handed to the wallet by `signAndBroadcast` below, which
 * states plainly that it has never run against a chain.
 */

export type WalletName = 'keplr' | 'leap' | 'cosmostation' | 'ninji' | 'owallet';

export interface WalletAccount {
  name: WalletName;
  /** bech32, `inj1…`. */
  address: string;
  /** The label the extension shows for this account. */
  label: string;
}

export class WalletError extends Error {
  readonly kind: 'absent' | 'rejected' | 'wrong-chain' | 'failed';
  constructor(kind: WalletError['kind'], message: string) {
    super(message);
    this.name = 'WalletError';
    this.kind = kind;
  }
}

interface InjectedWallet {
  enable(chainId: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string; name?: string }>;
  getOfflineSigner?: (chainId: string) => unknown;
  experimentalSuggestChain?: (c: unknown) => Promise<void>;
}

/**
 * The extensions this app knows how to talk to, in the order it offers them.
 *
 * All five expose the SAME injected surface: `window.<name>.enable(chainId)` and
 * `.getKey(chainId)`, the interface Keplr defined and the others implement for
 * compatibility. That is why adding one is a row here rather than an adapter: the
 * code path is identical and `available()` proves presence by reading the global
 * rather than by trusting this list.
 *
 * NOT HERE, deliberately: MetaMask and other Ethereum wallets. Injective accepts
 * them through EIP-712, but that is a different signing path with a different
 * account type, and listing one as if it worked would be the defect this project
 * keeps recording. A wallet is offered when its path has been written, not when
 * the chain could in principle accept it.
 *
 * `globalKey` exists because two of these do not inject under their own name:
 * Cosmostation uses `window.cosmostation.providers.keplr`, and Ninji injects as
 * `window.ninji`. Assuming `window[name]` for all five would have silently hidden
 * Cosmostation from every user who had it, which looks exactly like not having it.
 */
export const SUPPORTED: Array<{
  name: WalletName;
  label: string;
  install: string;
  /** Where on `window` the Keplr-compatible object actually lives. */
  globalKey: string;
}> = [
  { name: 'keplr', label: 'Keplr', install: 'https://www.keplr.app/download', globalKey: 'keplr' },
  { name: 'leap', label: 'Leap', install: 'https://www.leapwallet.io/download', globalKey: 'leap' },
  {
    name: 'ninji',
    label: 'Ninji',
    install: 'https://ninji.xyz',
    globalKey: 'ninji',
  },
  {
    name: 'cosmostation',
    label: 'Cosmostation',
    install: 'https://www.cosmostation.io/wallet',
    globalKey: 'cosmostation.providers.keplr',
  },
  {
    name: 'owallet',
    label: 'OWallet',
    install: 'https://owallet.dev',
    globalKey: 'owallet',
  },
];

function injected(name: WalletName): InjectedWallet | null {
  const meta = SUPPORTED.find((w) => w.name === name);
  if (!meta) return null;

  /*
   * Rooted at `globalThis`, not at `window`, and that is not a style choice.
   *
   * `window` does not exist under Node, so the whole of this function was
   * unreachable from a test: the guard returned null before anything else ran, and
   * detection for five wallets had no coverage at all. In a browser
   * `globalThis === window`, and during server rendering `globalThis` simply has no
   * extension on it, so the SSR behaviour is identical. The difference is that it
   * can now be exercised.
   */
  let node: unknown = globalThis;
  for (const part of meta.globalKey.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[part];
  }
  if (node === null || typeof node !== 'object') return null;

  /*
   * Checked for the methods it will actually be called with, not just for
   * presence. A page can carry a stub on `window.keplr` (another extension's
   * shim, a mock left by a test harness), and offering it as a wallet produces a
   * "not a function" at the moment the user clicks, which reads as the app being
   * broken rather than the wallet being absent.
   */
  const cand = node as Partial<InjectedWallet>;
  return typeof cand.enable === 'function' && typeof cand.getKey === 'function'
    ? (cand as InjectedWallet)
    : null;
}

/**
 * Which extensions are actually present.
 *
 * Read at call time rather than cached at module load: an extension injects
 * itself during page load, so a value captured at import can be empty on a page
 * where the wallet is in fact installed. That is a real race and it reads as
 * "no wallet" to the user.
 */
export function available(): WalletName[] {
  return SUPPORTED.filter((w) => injected(w.name) !== null).map((w) => w.name);
}

export async function connect(name: WalletName): Promise<WalletAccount> {
  const ext = injected(name);
  if (!ext) {
    const meta = SUPPORTED.find((w) => w.name === name);
    throw new WalletError(
      'absent',
      `${meta?.label ?? name} is not installed in this browser.`,
    );
  }

  try {
    // `enable` is what prompts the user. It throws on rejection, which is a
    // choice rather than a fault, so it gets its own kind.
    await ext.enable(NETWORK.chainId);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/reject|denied|closed/i.test(msg)) {
      throw new WalletError('rejected', 'You closed the wallet prompt, so nothing was connected.');
    }
    /*
     * Keplr answers an unknown chain id with a "there is no chain info" error.
     * Both wallets ship Injective mainnet and testnet, so this normally means the
     * configured chain id is wrong rather than that the user needs to add a chain,
     * and saying so sends them to the right place.
     */
    if (/no chain info|unknown chain|not supported/i.test(msg)) {
      throw new WalletError(
        'wrong-chain',
        `This wallet does not know the chain id ${NETWORK.chainId}. Check which network the app is configured for.`,
      );
    }
    throw new WalletError('failed', 'The wallet could not be opened.');
  }

  let key: { bech32Address: string; name?: string };
  try {
    key = await ext.getKey(NETWORK.chainId);
  } catch {
    throw new WalletError('failed', 'The wallet connected but would not share an address.');
  }

  if (!/^inj1[0-9a-z]{38,}$/.test(key.bech32Address)) {
    /*
     * A wallet pointed at a different Cosmos chain returns that chain's prefix,
     * and an address with the wrong prefix is not a mistake to paper over: funds
     * sent from it, or to it, go somewhere the user did not mean.
     */
    throw new WalletError(
      'wrong-chain',
      `That wallet returned ${key.bech32Address.split('1')[0] || 'an unexpected'} address rather than an Injective one.`,
    );
  }

  return { name, address: key.bech32Address, label: key.name || 'Account' };
}

/**
 * The connected account's quote balance, in base units.
 *
 * From the LCD rather than the wallet, because the extension reports whatever
 * chain it is currently pointed at and this must be the balance on the chain the
 * app is reading. Returns null when the account does not exist yet, which is the
 * normal state of a fresh address and not an error.
 */
export async function quoteBalance(address: string): Promise<bigint | null> {
  const url = `${getLcdUrl()}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(NETWORK.quoteDenom)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const json = (await res.json()) as { balance?: { amount?: string } };
  const raw = json.balance?.amount;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  return BigInt(raw);
}

/** Shorten an address for display without hiding which account it is. */
export function shortAddress(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 10)}…${addr.slice(-6)}` : addr;
}
