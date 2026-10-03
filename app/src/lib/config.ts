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
 */

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: NetworkName;
  chainId: string;
  /** REST (LCD) endpoint. Smart queries go over this, no SDK required. */
  lcd: string;
  explorer: string;
  quoteDenom: string;
  quoteSymbol: string;
  quoteDecimals: number;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    chainId: 'injective-888', // verified 3 Oct 2026
    lcd: 'https://testnet.sentry.lcd.injective.network',
    explorer: 'https://testnet.explorer.injective.network',
    quoteDenom: 'inj',
    quoteSymbol: 'INJ',
    quoteDecimals: 18,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 'injective-1', // verified 3 Oct 2026
    lcd: 'https://sentry.lcd.injective.network',
    explorer: 'https://explorer.injective.network',
    quoteDenom: 'inj',
    quoteSymbol: 'INJ',
    quoteDecimals: 18,
  },
};

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
