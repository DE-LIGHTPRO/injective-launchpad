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
  /**
   * The injected object this account came from.
   *
   * Carried rather than looked up again at signing time, because a browser can have
   * several of these installed and re-reading `window.keplr` would sign with whichever
   * one is there instead of the one the user chose. With five wallets offered that is
   * not hypothetical.
   */
  provider: unknown;
}

export class WalletError extends Error {
  readonly kind: 'absent' | 'rejected' | 'wrong-chain' | 'failed';
  /**
   * The extension's own words, kept rather than discarded.
   *
   * The first version of this threw away the original message and reported "The
   * wallet could not be opened." for anything it did not recognise. A real failure
   * then arrived with no information in it at all: the user saw a generic sentence,
   * and so did I, so there was nothing to diagnose from. Translating an error for a
   * person is right; destroying it is not. This is shown behind a disclosure and
   * logged, never used as the headline.
   */
  readonly detail?: string;
  constructor(kind: WalletError['kind'], message: string, detail?: string) {
    super(message);
    this.name = 'WalletError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Chain parameters for an extension that does not already know Injective.
 *
 * Keplr ships Injective MAINNET and, depending on the build, not the testnet. An
 * `enable('injective-888')` against a build without it throws, which is what produced
 * "The wallet could not be opened." on a browser with Keplr plainly installed.
 *
 * `coinType: 60` is the detail that matters most here: Injective derives Ethereum-style
 * keys, and suggesting coinType 118 like a standard Cosmos chain would hand back a
 * valid-looking `inj1…` address derived from the wrong path, for an account holding
 * nothing and signing nothing the chain accepts.
 */
function chainSuggestion() {
  const inj = { coinDenom: 'INJ', coinMinimalDenom: 'inj', coinDecimals: 18, coinGeckoId: 'injective-protocol' };
  const isTestnet = NETWORK.name === 'testnet';
  return {
    chainId: NETWORK.chainId,
    chainName: isTestnet ? 'Injective Testnet' : 'Injective',
    rpc: isTestnet
      ? 'https://testnet.sentry.tm.injective.network'
      : 'https://sentry.tm.injective.network',
    rest: NETWORK.lcd,
    bip44: { coinType: 60 },
    bech32Config: {
      bech32PrefixAccAddr: 'inj',
      bech32PrefixAccPub: 'injpub',
      bech32PrefixValAddr: 'injvaloper',
      bech32PrefixValPub: 'injvaloperpub',
      bech32PrefixConsAddr: 'injvalcons',
      bech32PrefixConsPub: 'injvalconspub',
    },
    currencies: [inj],
    feeCurrencies: [{ ...inj, gasPriceStep: { low: 500000000, average: 700000000, high: 900000000 } }],
    stakeCurrency: inj,
    features: ['ibc-transfer', 'ibc-go', 'eth-address-gen', 'eth-key-sign'],
  };
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
    const msg = errorText(e);

    if (/reject|denied|closed/i.test(msg)) {
      throw new WalletError('rejected', 'You closed the wallet prompt, so nothing was connected.');
    }

    /*
     * An unknown chain is ASKED FOR rather than reported.
     *
     * This used to say "this wallet does not know the chain id, check which network
     * the app is configured for", on the belief that both wallets ship Injective
     * mainnet and testnet. They do not: Keplr's build may carry mainnet only, so a
     * browser with Keplr plainly installed got told the app was misconfigured when
     * the fix was one call the extension exists to serve. Suggesting the chain shows
     * the user a prompt naming Injective, which is a better answer than a sentence
     * about chain ids.
     *
     * The retry is what proves it worked. Treating `suggestChain` as success without
     * re-enabling would report a connection that never happened.
     */
    if (/no chain info|unknown chain|not supported|chain.*not.*found/i.test(msg)) {
      if (typeof ext.experimentalSuggestChain === 'function') {
        try {
          await ext.experimentalSuggestChain(chainSuggestion());
          await ext.enable(NETWORK.chainId);
          return finishConnect(name, ext);
        } catch (suggestErr) {
          const sm = errorText(suggestErr);
          if (/reject|denied|closed/i.test(sm)) {
            throw new WalletError('rejected', 'You declined adding the Injective network.');
          }
          throw new WalletError(
            'wrong-chain',
            `This wallet could not add ${NETWORK.chainId}. Add Injective ${NETWORK.name} to it manually, then try again.`,
            sm,
          );
        }
      }
      throw new WalletError(
        'wrong-chain',
        `This wallet does not know ${NETWORK.chainId} and cannot be asked to add it. Add Injective ${NETWORK.name} to it manually.`,
        msg,
      );
    }

    /*
     * The fallback carries the detail. Without it this sentence was the only thing
     * anyone saw, including me, and a real failure became undiagnosable.
     */
    throw new WalletError(
      'failed',
      'The wallet did not open. Unlock it and try again.',
      msg,
    );
  }

  return finishConnect(name, ext);
}

/**
 * Pulls out whatever text an error carries.
 *
 * Extensions throw strings, plain objects and `Error`s interchangeably, and
 * `(e as Error).message` is `undefined` for two of those three. That `undefined`
 * matched none of the patterns above, which is how every unrecognised failure
 * collapsed into one generic sentence.
 */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error?: unknown };
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e ?? '');
}

async function finishConnect(name: WalletName, ext: InjectedWallet): Promise<WalletAccount> {

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

  return { name, address: key.bech32Address, label: key.name || 'Account', provider: ext };
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
  return denomBalance(address, NETWORK.quoteDenom);
}

/**
 * Any denom's balance, in base units, or null when it could not be read.
 *
 * `null` is NOT zero, and the distinction is the whole reason this returns one. An
 * unreachable LCD rendered as "0" tells a holder they have nothing, which on a sell
 * screen is the most alarming possible lie: it looks like their position is gone.
 * A bank query for a denom an account has never held returns a zero balance rather
 * than an error, so a real zero is still a real zero.
 */
export async function denomBalance(address: string, denom: string): Promise<bigint | null> {
  const url = `${getLcdUrl()}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`;
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
