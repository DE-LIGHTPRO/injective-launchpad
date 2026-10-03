'use client';

import { useMemo, useState } from 'react';
import {
  quoteBuy,
  priceImpactBps,
  IMPACT_WARN_BPS,
  IMPACT_SEVERE_BPS,
  quoteSell,
  parseAmount,
  fmt,
  CurveError,
  type CurveConfig,
  type CurveState,
} from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';

type Side = 'buy' | 'sell';

/**
 * Quotes are computed locally from the same maths the contract runs, so the
 * numbers move as you type without a round trip. `curve.test.ts` asserts them
 * against the Rust unit for unit, so the two cannot silently drift — a client
 * quote that disagrees with the chain is worse than no quote.
 */
export function TradePanel({
  config,
  state,
  symbol,
  tradingClosed,
}: {
  config: CurveConfig;
  state: CurveState;
  symbol: string;
  tradingClosed: boolean;
}) {
  const [side, setSide] = useState<Side>('buy');
  const [input, setInput] = useState('');
  const [slippagePct, setSlippagePct] = useState(1);

  const quote = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const raw = parseAmount(input);
      if (raw <= 0n) return null;
      return side === 'buy'
        ? ({ ok: true, side: 'buy', ...quoteBuy(config, state, raw) } as const)
        : ({ ok: true, side: 'sell', ...quoteSell(config, state, raw) } as const);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof CurveError ? e.message : 'That amount could not be quoted.',
      } as const;
    }
  }, [input, side, config, state]);

  /** Worst acceptable fill, sent as the contract's min_* guard. */
  const minOut = useMemo(() => {
    if (!quote?.ok) return 0n;
    const gross = quote.side === 'buy' ? quote.tokensOut : quote.injOut;
    return (gross * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
  }, [quote, slippagePct]);

  /*
   * Price impact, on a buy only.
   *
   * This panel disclosed the 1% fee and said nothing about the curve. On the shape
   * this project ships, 25 INJ into a fresh launch pays about 82% above spot, so the
   * disclosed cost was a fortieth of the real one and read as the whole of it.
   *
   * `null` means "not measurable", never zero. Zero impact is a claim, and on a
   * curve this steep it is the least likely claim to be true, so the row says so
   * rather than printing 0.00%.
   */
  const impactBps = useMemo(() => {
    if (!quote?.ok || quote.side !== 'buy') return null;
    try {
      return priceImpactBps(config, state, parseAmount(input || '0'));
    } catch {
      return null;
    }
  }, [quote, config, state, input]);

  if (tradingClosed) {
    return (
      <div className="card">
        <h2>Trading closed</h2>
        <p className="note">
          This launch has graduated. Its liquidity has moved on, so the curve no longer accepts
          buys or sells.
        </p>
      </div>
    );
  }

  const unit = side === 'buy' ? NETWORK.quoteSymbol : symbol;

  return (
    <div className="card">
      <div className="segmented" role="group" aria-label="Trade side">
        <button aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>

      <label className="field">
        <span className="lbl">
          <span>{side === 'buy' ? 'You spend' : 'You sell'}</span>
        </span>
        <span className="input-wrap">
          <input
            className="amount"
            inputMode="decimal"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label={`Amount of ${unit} to ${side}`}
          />
          <span className="unit">{unit}</span>
        </span>
      </label>

      {quote && !quote.ok && (
        <div className="quote-box">
          <p className="note danger-text" style={{ margin: 0 }}>
            {quote.error}
          </p>
        </div>
      )}

      {quote?.ok && (
        <div className="quote-box">
          <div className="metric-row">
            <span className="k">You receive</span>
            <span className="v mono">
              {quote.side === 'buy'
                ? `${fmt(quote.tokensOut, 18, 2)} ${symbol}`
                : `${fmt(quote.injOut, 18, 6)} ${NETWORK.quoteSymbol}`}
            </span>
          </div>
          <div className="metric-row">
            <span className="k">Fee · {Number(config.feeBps) / 100}%</span>
            <span className="v mono">
              {fmt(quote.fee, 18, 6)} {NETWORK.quoteSymbol}
            </span>
          </div>
                    {quote.side === 'buy' && (
            <div className="metric-row">
              <span
                className={
                  impactBps === null
                    ? 'k'
                    : impactBps >= IMPACT_SEVERE_BPS
                      ? 'k err-text'
                      : impactBps >= IMPACT_WARN_BPS
                        ? 'k warn-text'
                        : 'k'
                }
              >
                Price impact
              </span>
              <span
                className={
                  impactBps === null
                    ? 'v mono'
                    : impactBps >= IMPACT_SEVERE_BPS
                      ? 'v mono err-text'
                      : impactBps >= IMPACT_WARN_BPS
                        ? 'v mono warn-text'
                        : 'v mono'
                }
              >
                {impactBps === null ? 'not measurable' : `${(impactBps / 100).toFixed(2)}%`}
              </span>
            </div>
          )}
          {impactBps !== null && impactBps >= IMPACT_SEVERE_BPS && (
            <p className="note err-text">
              At this size most of what you spend goes into the curve rather than into
              tokens. The curve is steepest at the start, so a smaller buy pays a much
              better price.
            </p>
          )}
          <div className="metric-row">
            <span className="k">Minimum received</span>
            <span className="v mono">
              {quote.side === 'buy'
                ? `${fmt(minOut, 18, 2)} ${symbol}`
                : `${fmt(minOut, 18, 6)} ${NETWORK.quoteSymbol}`}
            </span>
          </div>
          {quote.side === 'buy' && quote.refund > 0n && (
            <div className="metric-row">
              <span className="k warn-text">Refunded · curve full</span>
              <span className="v mono warn-text">
                {fmt(quote.refund, 18, 6)} {NETWORK.quoteSymbol}
              </span>
            </div>
          )}
        </div>
      )}

      {quote?.ok && quote.side === 'buy' && quote.graduates && (
        <p className="note warn-text">
          This buy reaches the graduation target. It closes the curve and moves liquidity on.
        </p>
      )}

      <div className="field">
        <span className="lbl">
          <span>Slippage tolerance</span>
          <span className="mono">{slippagePct}%</span>
        </span>
        <div className="segmented" role="group" aria-label="Slippage tolerance">
          {[0.5, 1, 3].map((p) => (
            <button key={p} aria-pressed={slippagePct === p} onClick={() => setSlippagePct(p)}>
              {p}%
            </button>
          ))}
        </div>
      </div>

      <button className="go" disabled>
        {isDemoMode() ? 'Demo: trading disabled' : 'Connect wallet'}
      </button>

      <p className="note">
        {isDemoMode()
          ? 'This is a demo launch, so there is nothing to sign. The quote above is real arithmetic from the contract maths.'
          : 'Quotes come from the same curve maths the contract runs, checked against it unit for unit.'}
      </p>
    </div>
  );
}
