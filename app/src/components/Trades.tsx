import { listTrades, short, symbolOf, type Quote, type Trade } from '@/lib/chain';
import { firstBlockShare } from '@/lib/creatorHolding';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { buildSeries, changeBps, pathFor } from '@/lib/priceSeries';
import {
  uniqueTraders,
  volumeWithin,
  volumeIsPartial,
  BLOCKS_PER_DAY,
} from '@/lib/launchActivity';
import { currentHeight } from '@/lib/chain';
import { compact } from '@/lib/boardMetrics';

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
export async function Trades({
  curve,
  denom,
  totalSupply,
  quote,
}: {
  curve: string;
  denom: string;
  /** Base units as a string, for the opening-concentration figure. */
  totalSupply?: string;
  /**
   * THIS launch's quote. `buildSeries` takes the decimals because a fill price is
   * quote over tokens, so a 6-decimal quote read as 18 puts every point on the chart
   * out by a factor of a trillion.
   */
  quote: Quote;
}) {
  if (isDemoMode()) {
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

  let trades: Trade[];
  try {
    trades = await listTrades(curve, 25);
  } catch (e) {
    return (
      <div className="card">
        <h2>Trades</h2>
        <p className="note danger-text">{(e as Error).message}</p>
        <p className="note">This says nothing about whether the launch has traded.</p>
      </div>
    );
  }

  const sym = symbolOf(denom);

  /*
   * How much supply was taken in the opening blocks.
   *
   * Third-party analytics sell this as "bundle %", and a launchpad that charges a fee
   * on those trades and then leaves buyers to find the concentration on someone else's
   * site is choosing not to say. The function existed with its own tests and no call
   * site, which is this project's most-repeated defect, so this is the wiring.
   *
   * Only shown past a threshold. Every launch has a first buyer, and reporting "3% was
   * bought in the opening blocks" on all of them makes the number noise and teaches
   * people to skip it, which costs exactly the launches where it matters.
   */
  const opening = totalSupply ? firstBlockShare(trades, BigInt(totalSupply)) : null;
  const openingPct = opening?.share != null ? opening.share * 100 : null;

  const series = buildSeries(trades, quote.decimals);
  /*
   * Height for the 24h window, read here rather than passed in. `null` on failure,
   * which `volumeWithin` turns into "not measured" rather than zero: a day with no
   * trades and a day we could not measure must not read the same.
   */
  const height = await currentHeight().catch(() => null);
  const vol24 = volumeWithin(trades, height, BLOCKS_PER_DAY);
  const volPartial = volumeIsPartial(trades, trades.length, height, BLOCKS_PER_DAY);
  const traders = uniqueTraders(trades);
  const change = changeBps(series);
  const path = pathFor(series, 560, 60, 3);

  return (
    <div className="card">
      <h2>Trades</h2>

      {openingPct !== null && openingPct >= 20 && (
        <p className="note warn-text">
          {openingPct.toFixed(1)}% of the supply was bought within {opening?.blocks} blocks
          of the first trade. That is the window a buyer watching for the launch cannot
          realistically compete in.
        </p>
      )}

      {/*
          The history, which is a different question from the curve above it. The
          curve is what the contract WILL charge; this is what people actually
          paid, fee and their own price impact included. Labelled as fills for
          that reason: on a steep curve a large buy fills well above spot, and a
          chart drawn from spot would hide exactly that.
        */}
      {path && (
        <div className="spark">
          <div className="spark-head">
            <span className="note">Fill prices, oldest to newest</span>
            {change !== null && (
              <span className={`mono spark-change ${change >= 0 ? 'up' : 'down'}`}>
                {change >= 0 ? '+' : ''}
                {(change / 100).toFixed(2)}%
              </span>
            )}
          </div>
          <svg viewBox="0 0 560 60" width="100%" height="60" role="img"
               aria-label={`Fill prices across ${series.points.length} trades`}>
            <path d={path} fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="1.5"
                  strokeLinejoin="round" />
          </svg>
          <div className="spark-foot mono">
            <span>{series.low.toPrecision(3)}</span>
            <span>{series.high.toPrecision(3)} {quote.label} per {sym}</span>
          </div>
        </div>
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
          {trades.map((t, i) => (
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
