import { short, quoteMoved, type Quote } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { compact } from '@/lib/boardMetrics';
import { TRADE_LIMIT, TRADE_LIST_LIMIT, type TradeViewResult } from '@/lib/tradeView';
import { fillPrice } from '@/lib/priceSeries';

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
 *
 * Two of those three then split on `tradedOnChain`, the curve's own answer to "has
 * this ever traded", which the transaction search cannot give. Pruned history looks
 * identical to an untraded launch from here, so without it a graduated launch reads
 * as one nobody has bought.
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

  /*
   * A FAILED READ IS NOT EVIDENCE, BUT THE CURVE IS, and it is already on the page.
   *
   * This branch used to end in "This says nothing about whether the launch has
   * traded", which was honest about the tx search and weaker than what the render
   * holds: `tradedOnChain` comes from the contract's own state, read by a query that
   * succeeded. So when the curve says nothing has ever been sold, the answer is the
   * untraded state below rather than an error, whatever the search did; and when it
   * says the launch HAS traded, say that instead of declining to.
   */
  if (result.kind === 'error' && result.tradedOnChain) {
    return (
      <div className="card">
        <h2>Trades</h2>
        <p className="note danger-text">{result.message}</p>
        <p className="note">
          The curve&rsquo;s own state says this launch has traded. What could not be read is
          the record of those trades, not whether they happened.
        </p>
      </div>
    );
  }

  if (result.kind === 'error') {
    return (
      <div className="card">
        <h2>Trades</h2>
        <p className="note">
          Nothing yet. The curve reports nothing sold, so there is no history missing:
          the first buy will appear here within a block.
        </p>
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
      <div className="chart-head">
        <h2>Trades</h2>
        {/*
            The total, which is what a reader checks first and what every comparable
            launchpad prints beside the heading. It is the number ACTUALLY READ, not
            the lifetime count: the page fetches one tx-search page, so saying
            "50,189 total" when we read 200 would be a figure we cannot stand behind.
          */}
        {trades.length > 0 && (
          <span className="note">
            {trades.length >= TRADE_LIMIT ? `newest ${trades.length}` : `${trades.length} total`}
          </span>
        )}
      </div>

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
      {/*
          An empty result and an untraded launch are different things, and the search
          cannot separate them: the node indexes a window of recent blocks, so a
          launch older than that window can answer 200 with nothing in it. The curve
          settles which sentence this is.
        */}
      {trades.length === 0 && (
        <p className="note">
          {result.tradedOnChain
            ? 'The curve reports trades that this search did not return, so the record of them is older than the window the answering node keeps.'
            : 'Nothing yet. The first buy will appear here within a block.'}
        </p>
      )}
      {trades.length > 0 && (
        <ul className="trades">
          {/* The newest few. The chart above reads the whole page; a list of two
              hundred rows is a scroll, not a feed. */}
          {trades.slice(0, TRADE_LIST_LIMIT).map((t, i) => (
            <li key={`${t.txHash}-${i}`}>
              <span className={`trade-side ${t.kind}`}>{t.kind}</span>
              <span className="mono trade-amount">
                {/* What was spent, not what was offered. Printing `injIn` here beside
                    the filled price below put two numbers in one row that do not
                    divide into each other: on a partially filled buy the refund had
                    already gone back to the buyer. */}
                {t.kind === 'buy' && quoteMoved(t) !== null && (
                  <>
                    {fmt(quoteMoved(t)!, quote.decimals, 4)} {quote.label}
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
                {t.who && <span className="trade-who"> · {short(t.who)}</span>}
              </span>
              {/*
                  THE PRICE THIS TRADE FILLED AT, which the list did not show. Two
                  amounts leave a reader dividing one by the other in their head to
                  answer the question the row exists for, and it is the column every
                  comparable launchpad puts between the size and the age.
                */}
              <span className="mono trade-price">
                {(() => {
                  const p = fillPrice(t, quote.decimals);
                  return p === null ? '\u2014' : p.toPrecision(4);
                })()}
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
