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

  const { trades, series, sym, vol24, volPartial, traders, openingPct, openingBlocks, coverage } =
    result.view;

  /*
   * "N total" IS A COMPLETENESS CLAIM, and on the EVM backend it was a false one.
   * `eth_getLogs` is capped at 10,000 blocks a request, so history there is read over
   * two windows and `coverage.complete` says whether they cover everything since the
   * launch existed. With one trade found and a gap in the middle, "1 total" tells a
   * reader there has only ever been one. `coverage` is null on the CosmWasm backend,
   * where the count label keeps the behaviour it had.
   */
  const countIsAll = coverage === null ? trades.length < TRADE_LIMIT : coverage.complete === true;

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
            {countIsAll ? `${trades.length} total` : `newest ${trades.length}`}
          </span>
        )}
      </div>

      {/*
          WHICH BLOCKS THIS ACTUALLY READ, said plainly, because the list is a window
          and not a history. `eth_getLogs` on Injective's EVM refuses a range over
          10,000 blocks - measured, `-32000 maximum [from, to] blocks distance: 10000` -
          and at sub-second blocks a launch two days old is twenty-six requests away.
          So the reader walks a window at the head and a window at the launch's
          creation, which is where a bonding curve's trades actually are, and this says
          so rather than letting a prefix pass for the whole thing.

          Only when there IS a gap. A complete read needs no caveat, and printing one
          anyway would train a reader to skip it.
        */}
      {coverage !== null && coverage.complete !== true && trades.length > 0 && (
        <p className="note">
          Read from the chain&rsquo;s event log over{' '}
          {(coverage.head - coverage.scannedFrom).toLocaleString('en-US')} blocks up to the
          present
          {coverage.openingWindow !== null
            ? `, plus ${(
                coverage.openingWindow.to - coverage.openingWindow.from
              ).toLocaleString('en-US')} blocks from when this launch was created`
            : ''}
          . Trades between those two windows are not shown: this chain caps a log query
          at 10,000 blocks, so reading every block since the launch is not something a
          page load can do.
        </p>
      )}

      {/*
          NOTHING FOUND IS NOT NOTHING HAPPENED, where the read was a window. The
          curve's own state is on the page above and settles whether it has traded.
        */}
      {coverage !== null && coverage.complete !== true && trades.length === 0 && (
        <p className="note">
          No trades in the{' '}
          {(coverage.head - coverage.scannedFrom).toLocaleString('en-US')} blocks read up to
          the present
          {coverage.openingWindow !== null
            ? `, nor in the ${(
                coverage.openingWindow.to - coverage.openingWindow.from
              ).toLocaleString('en-US')} blocks after this launch was created`
            : ''}
          . That is a window, not the whole history: this chain caps a log query at
          10,000 blocks. What the curve itself reports about what has been sold is above.
        </p>
      )}

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
