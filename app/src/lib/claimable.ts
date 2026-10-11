/**
 * Which launches a wallet can claim fees from, and the total.
 *
 * EXTRACTED FROM THE COMPONENT, because a filter living inside a component is a
 * filter no test can reach, and this one decides whose money is shown. The create
 * page learned that lesson already: correct logic nobody could exercise is the
 * failure shape this codebase keeps finding.
 */

export interface ClaimRow {
  id: number;
  curve: string;
  symbol: string;
  creator: string;
  owed: bigint;
  quoteDenom: string;
}

export interface ClaimSelection<T extends ClaimRow = ClaimRow> {
  /** Launches this wallet created, whether or not anything is owed. */
  mine: T[];
  /** The subset with something to claim, which is what the button acts on. */
  withFees: T[];
  /** Totals per quote. Never one number: quotes are different assets. */
  totals: Array<{ quoteDenom: string; owed: bigint }>;
}

/**
 * CASE-SENSITIVE address comparison, deliberately.
 *
 * A bech32 address is lowercase by construction, so a case-insensitive match would
 * only ever paper over an address that had been mangled somewhere upstream, and
 * showing somebody another wallet's claimable fees is the worst way to find that out.
 */
/*
 * GENERIC over the row, so a caller carrying extra fields (a resolved `Quote`, for
 * instance) gets them back rather than having them cast away. The first version took
 * a bare `ClaimRow[]` and the component cast to it, which silently dropped the quote
 * every amount is rendered in.
 */
export function selectClaimable<T extends ClaimRow>(
  rows: T[],
  address: string | null,
): ClaimSelection<T> {
  if (!address) return { mine: [], withFees: [], totals: [] };
  const mine = rows.filter((r) => r.creator === address);
  const withFees = mine.filter((r) => r.owed > 0n);

  const byQuote = new Map<string, bigint>();
  for (const r of withFees) {
    byQuote.set(r.quoteDenom, (byQuote.get(r.quoteDenom) ?? 0n) + r.owed);
  }
  return {
    mine,
    withFees,
    totals: [...byQuote.entries()].map(([quoteDenom, owed]) => ({ quoteDenom, owed })),
  };
}
