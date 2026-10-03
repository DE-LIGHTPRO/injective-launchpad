import { listTrades, short, symbolOf, type Trade } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';

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

  return (
    <div className="card">
      <h2>Trades</h2>
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
