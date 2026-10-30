/**
 * The one form an EVM launch's token identifier takes, and the one place it is read.
 *
 * WHY A FORM AT ALL. The app's `denom` field carries "the identifier the chain knows
 * this token by". On CosmWasm that is a tokenfactory denom, `factory/<creator>/<SUB>`,
 * and the UI derives a ticker from its last segment. An EVM token is an address, which
 * carries no ticker, so the symbol has to travel with it or every row and heading
 * renders a hex string.
 *
 * ONE RESOLVER, because it already went wrong the other way. `listLaunchesEvm` built
 * `evm/<address>/<SYMBOL>` and `getLaunchDetailEvm` returned the bare address, so the
 * board and the launch page disagreed about what a token was called, and the launch
 * page showed the contract address as the token's name. Two builders for one format
 * is the defect this codebase keeps recording; this is the single one.
 */

/** `evm/0xabc…/PAD`. The symbol is last, matching the tokenfactory shape. */
export function evmDenom(token: string, symbol: string): string {
  return symbol ? `evm/${token}/${symbol}` : `evm/${token}`;
}

/** The token's contract address, whatever form the denom is in. */
export function tokenAddressOf(denom: string): string | null {
  return denom.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? null;
}

/**
 * The ticker, or null when the denom carries none.
 *
 * Null rather than the address: a caller that falls back to a truncated hex should
 * do so visibly, not because this quietly returned one.
 */
export function evmSymbolOf(denom: string): string | null {
  if (!denom.startsWith('evm/')) return null;
  const parts = denom.split('/');
  return parts.length >= 3 && parts[2].length > 0 ? parts[2] : null;
}
