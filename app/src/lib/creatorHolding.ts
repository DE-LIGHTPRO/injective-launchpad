import { denomBalance } from './wallet.ts';

/**
 * How much of the supply the creator still holds.
 *
 * THE ONE HOLDER FIGURE THIS CHAIN CAN ACTUALLY PRODUCE, and it is the one people most
 * want. A full holder list is not available: `denom_owners` returns 501 for a factory
 * denom on Injective and the explorer serves HTML rather than an API, so "2,650
 * holders" of the kind nearly.trade and pump.fun show needs an indexer nobody here is
 * running. But the creator is a single known address, so their balance is one bank
 * query, and "the dev holds 40%" is the number that actually decides whether someone
 * buys.
 *
 * It is also the number most worth being careful with, in both directions:
 *
 *   - A creator who holds nothing may have sold, or may simply never have bought. Those
 *     are opposite facts and the balance alone cannot tell them apart, so this reports
 *     the holding and never infers a sale.
 *   - A creator can hold tokens in a second address. This measures one address, which
 *     is a floor on their position and not a ceiling, and the UI says so rather than
 *     presenting it as the whole picture.
 */

export interface CreatorHolding {
  /** Base units held by the creator's launch address, or null when the read failed. */
  held: bigint | null;
  /** Share of the total supply, 0 to 1, or null when unknown. */
  share: number | null;
}

export const UNKNOWN_HOLDING: CreatorHolding = { held: null, share: null };

/**
 * `null` is "not read", never zero.
 *
 * An unreachable LCD rendered as 0% would say the creator holds nothing, which is the
 * single most reassuring thing this page can claim and the one it must never guess at.
 */
export async function readCreatorHolding(
  creator: string,
  denom: string,
  totalSupply: bigint,
): Promise<CreatorHolding> {
  const held = await denomBalance(creator, denom);
  if (held === null) return UNKNOWN_HOLDING;
  if (totalSupply <= 0n) return { held, share: null };
  /*
   * Through Number only for the ratio, which is a display figure. The operands are
   * both 18-decimal, so the division is well inside what a double represents exactly
   * enough for a percentage.
   */
  return { held, share: Number(held) / Number(totalSupply) };
}

/**
 * How a creator's position should read, which is not just a percentage.
 *
 * The thresholds are stated rather than tuned to look reassuring. A creator holding
 * most of the supply can end the launch by selling, and that is worth saying plainly;
 * one holding none of it is not automatically trustworthy, because the tokens could be
 * in another address this cannot see.
 */
export function describeCreatorHolding(h: CreatorHolding): {
  text: string;
  tone: 'muted' | 'warn' | 'danger';
} {
  if (h.share === null) {
    return { text: 'Creator holding could not be read', tone: 'muted' };
  }
  const pct = (h.share * 100).toFixed(1);
  if (h.share >= 0.2) {
    return {
      text: `Creator holds ${pct}% of supply at this address. A position that size can move the price on its own.`,
      tone: 'danger',
    };
  }
  if (h.share >= 0.05) {
    return { text: `Creator holds ${pct}% of supply at this address.`, tone: 'warn' };
  }
  if (h.share > 0) {
    return { text: `Creator holds ${pct}% of supply at this address.`, tone: 'muted' };
  }
  /*
   * Zero is reported as zero AT THIS ADDRESS, never as "the creator has sold" and
   * never as "no creator holdings". Both would be claims the measurement cannot
   * support: they may never have bought, and they may hold the rest elsewhere.
   */
  return { text: 'Creator holds none of the supply at this address.', tone: 'muted' };
}

/**
 * Supply bought in the launch's first blocks.
 *
 * What third-party tools call "bundle %", and what every analytics site on Solana sells
 * as a paid feature: supply taken before anyone outside the launch could reasonably
 * have seen it. A launchpad that charges a fee on those trades and then leaves buyers
 * to discover the concentration elsewhere is choosing not to say.
 *
 * Measured in BLOCKS, not seconds, because that is the unit the advantage is in. A
 * sniper is not fast in wall-clock terms; it is in the same block as the launch.
 */
export function firstBlockShare(
  trades: Array<{ kind: string; tokens: bigint | null; height: number }>,
  totalSupply: bigint,
  windowBlocks = 3,
): { share: number | null; blocks: number } {
  const buys = trades.filter((t) => t.kind === 'buy' && t.tokens !== null && t.tokens > 0n);
  if (buys.length === 0 || totalSupply <= 0n) return { share: null, blocks: windowBlocks };

  // The launch's own first trade sets the origin: a curve created long before anyone
  // traded it has no "first block" worth measuring from its creation.
  const first = Math.min(...buys.map((t) => t.height));
  const within = buys.filter((t) => t.height < first + windowBlocks);
  const taken = within.reduce((a, t) => a + (t.tokens ?? 0n), 0n);
  return { share: Number(taken) / Number(totalSupply), blocks: windowBlocks };
}
