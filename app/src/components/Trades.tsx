import { listTrades, short, symbolOf, type Trade } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { buildSeries, changeBps, pathFor } from '@/lib/priceSeries';

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
export async function Trades({ curve, denom }: { curve: string; denom: string }) {
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
  const series = buildSeries(trades, NETWORK.quoteDecimals);
  const change = changeBps(series);
  const path = pathFor(series, 560, 60, 3);

  return (
    <div className="card">
      <h2>Trades</h2>

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
            <span>{series.high.toPrecision(3)} {NETWORK.quoteSymbol} per {sym}</span>
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
                    {fmt(t.injIn, NETWORK.quoteDecimals, 4)} {NETWORK.quoteSymbol}
                    {t.tokens !== null && <> for {fmt(t.tokens, 18, 0)} {sym}</>}
                  </>
                )}
                {t.kind === 'sell' && t.tokens !== null && (
                  <>
                    {fmt(t.tokens, 18, 0)} {sym}
                    {t.injOut !== null && <> for {fmt(t.injOut, NETWORK.quoteDecimals, 4)} {NETWORK.quoteSymbol}</>}
                  </>
                )}
                {t.kind === 'graduate' && <>liquidity migrated</>}
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
