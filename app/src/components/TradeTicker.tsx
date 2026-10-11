import Link from 'next/link';
import { recentTrades, blocksAgo } from '@/lib/recentTrades';
import { addressName } from '@/lib/addressName';
import { fmt } from '@/lib/curve';

/**
 * What is happening right now, across the board.
 *
 * Both nearly.trade and ponsfamily.com lead with this, and it is the single thing
 * that makes a launchpad feel inhabited rather than catalogued: a visitor can see
 * that other people are here.
 *
 * It renders NOTHING when there are no trades. An empty ticker with headers is worse
 * than no ticker: it reserves space for activity and then reports the absence of it,
 * which on a new launchpad is the most discouraging thing the page could do.
 */
export async function TradeTicker({
  launches,
  currentHeight,
}: {
  launches: Array<{ id: number; curve: string; denom: string; quoteDecimals: number; quoteLabel: string }>;
  currentHeight: number | null;
}) {
  /*
   * The most recent launches, not all of them. Trades live on each curve's own
   * contract and the tx search has no OR across addresses, so every launch covered
   * is another round trip. Eight is enough to look alive and cheap enough not to
   * delay the board.
   */
  const covered = launches.slice(0, 8);
  const ticker = await recentTrades(covered);
  if (ticker.trades.length === 0) return null;

  return (
    <div className="ticker">
      <div className="ticker-head">
        <span className="k">Recent trades</span>
        {/*
            The scope, stated. A feed labelled "recent trades" that silently omits
            launches tells a visitor the rest of the board is quiet, when all it
            really says is that nothing outside this window was asked about.
          */}
        <span className="note">
          {ticker.covered} newest launches
          {ticker.partial && ' · some unavailable'}
        </span>
      </div>
      <ul>
        {ticker.trades.map((t) => (
          <li key={t.txHash + t.symbol}>
            <span className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side}</span>
            <Link href={`/launch/${t.launchId}`} className="ticker-sym">
              {t.symbol}
            </Link>
            <span className="mono ticker-amt">
              {/* The launch's own quote: this read every amount at 18 decimals as INJ,
                  so a TUSD buy showed as "0 INJ". */}
              {fmt(t.quote, t.quoteDecimals, 3)} {t.quoteLabel}
            </span>
            {/* The trader as a readable name, address in the title: a label, not an
                identity, exactly as on the cards. */}
            <span className="ticker-who" title={t.who ?? undefined}>
              {t.who ? addressName(t.who) : 'unknown'}
            </span>
            <span className="ticker-age">{blocksAgo(t.height, currentHeight) ?? ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
