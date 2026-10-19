/**
 * Chain and contract wiring.
 *
 * Two rules carried over from Sealed, both learned the hard way:
 *
 *  - **One resolver per endpoint, and a fallback never counts as configured.**
 *    On Arc the RPC was read from two different variables; an operator could
 *    follow the runbook exactly, watch readiness go green, and still have
 *    every transaction pointed at a hardcoded default they never chose. So
 *    there is exactly one accessor for each value here, and `isConfigured`
 *    is false whenever the default is in use.
 *
 *  - **Confirm hosts, never infer them.** The Arc mainnet RPC was inferred
 *    from the testnet's naming and turned out to have no DNS record at all.
 *    The two endpoints below were checked against
 *    `/cosmos/base/tendermint/v1beta1/node_info` and answer with chain ids
 *    `injective-888` and `injective-1` respectively. If you change one,
 *    re-check it rather than trusting the pattern.
 *
 * AND CONFIRM THE PATH, not only the host. Both explorers were
 * `*.explorer.injective.network`, which 301s to injscan - and on TESTNET that redirect
 * discards the path: `testnet.explorer.injective.network/contract/inj1u35…` answers
 * `location: https://testnet.injscan.com`, so every explorer link in the product
 * landed on the explorer's front page. Measured 16 Oct 2026 from the Location header,
 * and the mainnet host preserves the path, so the two did not fail the same way and
 * checking one would have cleared both. The routes here are the explorer's own, read
 * out of its Nuxt route table: `/contract/:contract`, `/account/:account`,
 * `/transaction/:transaction`, `/code/:code`.
 *
 * injscan.com answers those deep links with a soft 404 - byte-identical to the body it
 * returns for a nonsense route, while a prerendered path like `/transactions` is 200 -
 * so the status is its static host's and the client router renders the page. Worth
 * knowing before reading a 404 here as a broken link.
 */

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: NetworkName;
  chainId: string;
  /** REST (LCD) endpoint. Smart queries go over this, no SDK required. */
  lcd: string;
  explorer: string;
  quoteDenom: string;
  /**
   * What gas is paid in, which is NOT the same concept as the default quote even
   * where it is the same denom.
   *
   * They were one field, and the collision showed up the moment a launch could be
   * priced in something else: code reserving gas reached for `quoteDenom` and read
   * correctly on Injective by luck, while the quote-labelling guard could not tell
   * that use from a launch's amounts being mislabelled. Separate names, so each use
   * says which it means.
   */
  gasDenom: string;
  quoteSymbol: string;
  quoteDecimals: number;
  /**
   * How to render an amount of the GAS asset, which is a different decision from
   * how to render a quote even when the two denoms coincide.
   *
   * SPLITTING `quoteDenom` FROM `gasDenom` ABOVE STOPPED ONE FIELD SHORT. Every
   * figure in the create form's cost row - the Injective denom-creation fee, the
   * gas reserve, the wallet's spendable balance - is denominated in `gasDenom`,
   * and all of them were scaled by `quoteDecimals` and labelled `quoteSymbol`.
   * The denom being read and the decimals being applied came from two different
   * fields, which is the same collision the comment above records, one field over.
   *
   * It reads correctly today only because `inj` is both, so the numbers agree by
   * coincidence rather than by construction. Pointing a deployment's quote at a
   * 6-decimal asset would have printed the denom fee off by a factor of 10^12 in
   * the one place the creator checks what signing costs. Named fields so each use
   * says which asset it means, and a guard keeps the cost row on these.
   */
  gasSymbol: string;
  gasDecimals: number;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    chainId: 'injective-888', // verified 3 Oct 2026
    lcd: 'https://testnet.sentry.lcd.injective.network',
    // Not testnet.explorer.injective.network: its redirect drops the path. See above.
    explorer: 'https://testnet.injscan.com',
    quoteDenom: 'inj',
    gasDenom: 'inj',
    quoteSymbol: 'INJ',
    quoteDecimals: 18,
    gasSymbol: 'INJ',
    gasDecimals: 18,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 'injective-1', // verified 3 Oct 2026
    lcd: 'https://sentry.lcd.injective.network',
    // The redirect target, used directly: one hop fewer, and the hop is what broke
    // testnet. Confirmed 16 Oct 2026 as this host's own 301 destination, path intact.
    explorer: 'https://injscan.com',
    quoteDenom: 'inj',
    gasDenom: 'inj',
    quoteSymbol: 'INJ',
    quoteDecimals: 18,
    gasSymbol: 'INJ',
    gasDecimals: 18,
  },
};

/**
 * What this app pays per unit of gas, in `inj` base units.
 *
 * ONE COPY, because there were two bare literals for one decision. `broadcast.ts`
 * multiplied the gas limit by `500_000_000n` to build every fee, and `wallet.ts`
 * separately told Keplr `gasPriceStep: { low: 500000000, ... }` in the chain it
 * suggests. Nothing connected them, so correcting one would have left a wallet
 * quoting a price the app does not pay - and a Keplr `low` below what we send is the
 * quiet direction: the extension shows the user a cheaper fee than the transaction
 * carries.
 *
 * IT IS NOT THE CHAIN'S MINIMUM, which `broadcast.ts` used to call it. Re-measured on
 * 16 Oct 2026 from `/cosmos/base/node/v1beta1/config`, BOTH chains report
 * `minimum_gas_price: 160000000.000000000000000000inj`:
 *
 *     sentry.lcd.injective.network          160000000inj
 *     testnet.sentry.lcd.injective.network  160000000inj
 *
 * So this is a deliberate 3.1x margin over the floor, not a property of the chain.
 * Keep the margin: the floor is set per node, a validator may set a higher one, and
 * the whole fee on a 3,000,000-gas launch is 0.0015 INJ against 0.00048 at the floor.
 * Fractions of a cent to never be refused for underpaying. The reason to write the
 * measurement down is that somebody reading "the minimum" would reasonably correct
 * the number DOWN to it.
 */
export const GAS_PRICE_INJ = 500_000_000n;

/** Testnet unless deliberately overridden. Mainnet is never the default. */
export const NETWORK: NetworkConfig =
  NETWORKS[(process.env.NEXT_PUBLIC_NETWORK as NetworkName) ?? 'testnet'] ?? NETWORKS.testnet;

/**
 * The single resolver for the LCD endpoint. If an override is set it wins;
 * otherwise the verified default is used — but `isLcdConfigured()` reports
 * false in that case, so nothing can treat "it happened to work" as "an
 * operator chose this".
 */
export function getLcdUrl(): string {
  return process.env.NEXT_PUBLIC_LCD_URL?.trim() || NETWORK.lcd;
}

export function isLcdConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_LCD_URL?.trim());
}

/**
 * Curve code ids the operator has published and vouches for, comma separated. NOT an
 * audit: see `codeCheck.ts`. The launch page refuses to
 * offer trading on a curve running anything else. Empty means not pinned (pre-audit).
 */
export function getPinnedCurveCodeIdsRaw(): string {
  return process.env.NEXT_PUBLIC_CURVE_CODE_IDS?.trim() ?? '';
}

/**
 * Curve code HASHES the operator vouches for, comma separated hex. The stronger pin and
 * the one to prefer: a hash can be rebuilt from this repository and compared, where a
 * code id can only be taken on the operator's word, and a hash means the same thing on
 * every chain where a code id does not. When this is set it decides the verdict and the
 * id list is not consulted. See `codeCheck.ts`.
 */
export function getPinnedCurveCodeHashesRaw(): string {
  return process.env.NEXT_PUBLIC_CURVE_CODE_HASHES?.trim() ?? '';
}

/** The single resolver for the factory address. */
export function getFactoryAddress(): string {
  return process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim() ?? '';
}

export function isDeployed(): boolean {
  return getFactoryAddress().length > 0;
}

/**
 * Developer-facing detail — variable names, setup hints, raw endpoints — is
 * shown only in a dev build. An end user staring at a launchpad has no use
 * for an env var name, and it leaks how the deployment is wired.
 */
export function isDevBuild(): boolean {
  return process.env.NODE_ENV !== 'production';
}
