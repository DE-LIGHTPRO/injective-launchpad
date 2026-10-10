import { listTrades, symbolOf, type Trade } from './chain.ts';

/**
 * Recent trades across several launches, for the board's ticker.
 *
 * WHY IT IS BOUNDED, and why that has to be said on screen. Trades live on each
 * curve's own contract, and Injective's tx search has no OR across contract
 * addresses, so "every recent trade" means one query per launch. On a board of fifty
 * that is fifty round trips to render a strip, and the strip is the least important
 * thing on the page.
 *
 * So it covers a fixed number of launches, and the component says which. A ticker
 * labelled "recent trades" that silently omits launches is a quiet lie about how busy
 * the rest of the board is: a visitor reads an empty-looking feed as a quiet market
 * rather than as a partial query.
 */

export interface TickerTrade {
  side: 'buy' | 'sell';
  /** The trader's address, or null when the contract did not name one. */
  who: string | null;
  /** Quote moved, base units. */
  quote: bigint;
  symbol: string;
  launchId: number;
  height: number;
  txHash: string;
}

export interface Ticker {
  trades: TickerTrade[];
  /** How many launches were actually queried, for the label. */
  covered: number;
  /** True when at least one query failed, so the feed is known to be incomplete. */
  partial: boolean;
}

/**
 * Merge the latest trades from a handful of curves, newest first.
 *
 * Queries run together rather than in sequence: serially, a strip of ten launches
 * would add ten round trips to the page's time to first byte, and a ticker is not
 * worth delaying the board for.
 */
export async function recentTrades(
  launches: Array<{ id: number; curve: string; denom: string }>,
  perLaunch = 5,
  limit = 8,
): Promise<Ticker> {
  if (launches.length === 0) return { trades: [], covered: 0, partial: false };

  const results = await Promise.allSettled(
    launches.map(async (l) => ({ launch: l, trades: await listTrades(l.curve, perLaunch) })),
  );

  let partial = false;
  const out: TickerTrade[] = [];
  for (const r of results) {
    if (r.status === 'rejected') {
      /*
       * One unreachable curve must not empty the whole strip, and must not be hidden
       * either. A feed that silently drops a launch reads as that launch having no
       * activity, which is the opposite of what a failed read means.
       */
      partial = true;
      continue;
    }
    const { launch, trades } = r.value;
    for (const t of trades) {
      const side = t.kind === 'buy' ? 'buy' : t.kind === 'sell' ? 'sell' : null;
      if (side === null) continue;
      // Graduation and anything unrecognised are not trades and carry no quote.
      const quote = side === 'buy' ? t.injIn : t.injOut;
      if (quote === null || quote <= 0n) continue;
      out.push({
        side,
        who: t.who,
        quote,
        symbol: symbolOf(launch.denom),
        launchId: launch.id,
        height: t.height,
        txHash: t.txHash,
      });
    }
  }

  /*
   * Sorted by block height, which is the only ordering this chain gives. Two trades
   * in one block have no defined order between them and are left in whatever order
   * the queries returned, rather than being tie-broken by something that would look
   * like time and is not.
   */
  out.sort((a, b) => b.height - a.height);
  return { trades: out.slice(0, limit), covered: results.length, partial };
}

/**
 * Relative age from a block height difference.
 *
 * Injective targets sub-second blocks, so height is a usable clock over the minutes a
 * ticker covers. It is an APPROXIMATION and the copy says "about": block time varies,
 * and presenting a derived figure as a timestamp is the kind of precision this
 * project removes elsewhere.
 */
export function blocksAgo(height: number, currentHeight: number | null): string | null {
  if (currentHeight === null || height > currentHeight) return null;
  const blocks = currentHeight - height;
  const secs = Math.round(blocks * 0.8);
  if (secs < 60) return `${secs}s`;
  if (secs < 3_600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3_600)}h`;
}
