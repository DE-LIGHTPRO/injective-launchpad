import { short, type Quote } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { compact } from '@/lib/boardMetrics';
import { TRADE_LIST_LIMIT, type TradeViewResult } from '@/lib/tradeView';

/**
 * Recent trades, read from transaction events.
 *
 * The contract stores no history on purpose: a launch keeps its position, not
 * its past, and paying storage for a feed nobody settles against is the wrong
 * trade. So this reads the chain's own tx search, which needs no indexer.
 *
 * Three states, kept distinct because they send a reader to different places.
 * No trades yet is the normal state of a new launch. An unreachable node is not
 * evidence about trading. And demo mode has no chain to read at all, which is
 * said rather than shown as an empty list.
 */
export function Trades({ result, quote }: { result: TradeViewResult; quote: Quote }) {
  if (result.kind === 'demo') {
    return (
      <div className="card">
        <h2>Trades</h2>
        <p className="note">
          This is a demo launch, so there are no transactions to read. On a real launch every buy
          and sell appears here, taken from the chain&rsquo;s own transaction log rather than from
          anything this page keeps.
        </p>
      </div>
    );
  }

  if (result.kind === 'error') {
    return (
      <div className="card">
        <h2>Trades</h2>
        <p className="note danger-text">{result.message}</p>
        <p className="note">This says nothing about whether the launch has traded.</p>
      </div>
    );
  }

  const { trades, series, sym, vol24, volPartial, traders, openingPct, openingBlocks } =
    result.view;

  /*
   * NO CHART HERE. There was a 60-pixel candle strip at the top of this card, under a
   * full-size bonding curve in the card above it. The candles are the page's main
   * chart now (`PriceChart`), and leaving a second drawing of the same series here
   * would be two charts of one fact, disagreeing the moment either changed.
   */
  return (
    <div className="card">
      <h2>Trades</h2>

      {openingPct !== null && openingPct >= 20 && (
        <p className="note warn-text">
          {openingPct.toFixed(1)}% of the supply was bought within {openingBlocks} blocks
          of the first trade. That is the window a buyer watching for the launch cannot
          realistically compete in.
        </p>
      )}

      {/*
          The figures a launch page is read for, from the trades already fetched above
          rather than from three more requests.

          ATH is `series.high`, which is the highest FILL, not the highest spot price.
          On a steep curve a large buy fills above spot, so this is the most anyone has
          actually paid, which is the number a reader thinks "all time high" means.

          TRADERS, never holders. `denom_owners` answers 501 Not Implemented on
          Injective, and deriving holders from trade history would be wrong: a
          tokenfactory denom is a bank denom, a bank send runs no contract code, so
          every transfer off the curve is invisible here. Someone who bought and sold
          out is counted below and holds nothing.
        */}
      {trades.length > 0 && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div className="metric-row">
            <span className="k">Highest fill</span>
            <span className="v mono">
              {series.high > 0 ? `${series.high.toPrecision(4)} ${quote.label}` : 'not priced'}
            </span>
          </div>
          <div className="metric-row">
            <span className="k">Volume, about 24h</span>
            <span className="v mono">
              {vol24 === null
                ? 'not measured'
                : `${volPartial ? 'at least ' : ''}${compact(vol24, quote.decimals, 4)} ${quote.label}`}
            </span>
          </div>
          <div className="metric-row">
            <span className="k">Traders, not holders</span>
            <span className="v mono">{traders.toLocaleString('en-US')}</span>
          </div>
        </div>
      )}

      {series.unpriceable > 0 && (
        <p className="note">
          {series.unpriceable} of these carried amounts that could not be priced, so they are not
          on the line above.
        </p>
      )}
      {trades.length === 0 && (
        <p className="note">
          Nothing yet. The first buy will appear here within a block.
        </p>
      )}
      {trades.length > 0 && (
        <ul className="trades">
          {/* The newest few. The chart above reads the whole page; a list of two
              hundred rows is a scroll, not a feed. */}
          {trades.slice(0, TRADE_LIST_LIMIT).map((t, i) => (
            <li key={`${t.txHash}-${i}`}>
              <span className={`trade-side ${t.kind}`}>{t.kind}</span>
              <span className="mono" style={{ fontSize: 'var(--text-sm)', minWidth: 0 }}>
                {t.kind === 'buy' && t.injIn !== null && (
                  <>
                    {fmt(t.injIn, quote.decimals, 4)} {quote.label}
                    {t.tokens !== null && <> for {fmt(t.tokens, 18, 0)} {sym}</>}
                  </>
                )}
                {t.kind === 'sell' && t.tokens !== null && (
                  <>
                    {fmt(t.tokens, 18, 0)} {sym}
                    {t.injOut !== null && <> for {fmt(t.injOut, quote.decimals, 4)} {quote.label}</>}
                  </>
                )}
                {t.kind === 'graduate' && <>locked pool seeded</>}
                {t.who && <span style={{ color: 'var(--text-faint)' }}> · {short(t.who)}</span>}
              </span>
              <a
                className="mono"
                style={{ fontSize: 'var(--text-micro)', color: 'var(--text-faint)' }}
                href={`${NETWORK.explorer}/transaction/${t.txHash}`}
                target="_blank"
                rel="noopener"
              >
                {t.height > 0 ? t.height.toLocaleString('en-US') : 'tx'}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
