'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  quoteBuy,
  priceImpactBps,
  sellPriceImpactBps,
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
import { buyingOpenAt, feeBpsAt, secondsUntilBaseFee, NO_RULES, type LaunchRules } from '@/lib/launchRules';

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
  rules = NO_RULES,
}: {
  config: CurveConfig;
  state: CurveState;
  symbol: string;
  tradingClosed: boolean;
  rules?: LaunchRules;
}) {
  const [side, setSide] = useState<Side>('buy');
  const [input, setInput] = useState('');
  const [slippagePct, setSlippagePct] = useState(1);

  /*
   * A launch that has not opened yet gets its own state, and this was missing.
   *
   * `buyingOpenAt` existed with six tests and no call site: the panel rendered a live
   * quote and a button for a launch the contract would refuse at signing, which is the
   * worst version of this because the price looks real right up to the wallet popup.
   * Found by sweeping for exported symbols nothing reaches, not by using the page.
   *
   * Ticking rather than read once, so the panel opens on its own at the start time. A
   * state that requires a reload to clear reads as a broken page, and the one minute
   * after a launch opens is the minute people are actually looking at it.
   */
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const notOpenYet = !tradingClosed && !buyingOpenAt(rules, now);
  useEffect(() => {
    if (!notOpenYet) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, [notOpenYet]);

  /*
   * The fee THIS BLOCK charges, which during an opening window is not the curve's own.
   *
   * The panel showed `config.feeBps` and quoted with it, so for the length of a decay
   * it promised more tokens than the chain would deliver. A quote that disagrees with
   * settlement is the defect this codebase calls a faked execution path, and it is
   * worse than no quote because it looks right until the wallet opens.
   *
   * Ticks while the premium is running, both so the figure stays true and so a buyer
   * can watch it fall, which is the behaviour the rule is trying to encourage.
   */
  const baseBps = Number(config.feeBps);
  const chargedBps = feeBpsAt(rules, baseBps, now);
  const premiumBps = Math.max(0, chargedBps - baseBps);
  const decaySecondsLeft = secondsUntilBaseFee(rules, now);
  useEffect(() => {
    if (decaySecondsLeft === null) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, [decaySecondsLeft]);

  const quote = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const raw = parseAmount(input);
      if (raw <= 0n) return null;
      /*
       * The premium comes off the top before the curve is quoted, exactly as the
       * contract does it. Folding it into `config.feeBps` would be the other way to
       * write this and it is the one the maths crate refuses, since its own fee cap
       * is below what an opening fee is meant to reach.
       *
       * Sells are untouched: the rule is a charge for taking the opening, not an exit
       * tax, and applying it to sells would punish an early buyer for changing their
       * mind.
       */
      const premium =
        side === 'buy' && premiumBps > 0 ? (raw * BigInt(premiumBps)) / 10_000n : 0n;
      const forCurve = raw - premium;
      return side === 'buy'
        ? ({
            ok: true,
            side: 'buy',
            ...quoteBuy(config, state, forCurve),
            earlyFeePremium: premium,
          } as const)
        : ({ ok: true, side: 'sell', ...quoteSell(config, state, raw) } as const);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof CurveError ? e.message : 'That amount could not be quoted.',
      } as const;
    }
  }, [input, side, config, state, premiumBps]);

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
    if (!quote?.ok) return null;
    try {
      const raw = parseAmount(input || '0');
      // Both sides, because the exit is where a holder is most exposed and it had
      // no disclosure at all: selling a quarter of a position on this shape pays
      // about 25% below spot, against the 1% fee shown beside it.
      return quote.side === 'buy'
        ? priceImpactBps(config, state, raw)
        : sellPriceImpactBps(config, state, raw);
    } catch {
      return null;
    }
  }, [quote, config, state, input]);

  if (notOpenYet && rules.tradeStart !== null) {
    return (
      <div className="card">
        <h2>Not open yet</h2>
        <p className="note">
          {/*
              The time is named, and named in UTC. A launch that says only "opens soon"
              gives nobody a reason to come back at the right moment, and a local time
              rendered from a server is the server's local time rather than the
              reader's.
            */}
          Buying opens at{' '}
          <strong>
            {new Date(rules.tradeStart * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC
          </strong>
          . The curve refuses every buy before then, so there is no advantage to being early.
        </p>
        <p className="note">
          {/*
              The clock caveat, stated rather than hidden. The contract gates on BLOCK
              time and this panel reads the browser's, so the two can disagree by a few
              seconds. Promising the button will work at the exact second would be a
              claim this page cannot keep.
            */}
          The contract gates on block time, so the first block after this may land a few
          seconds either side.
        </p>
      </div>
    );
  }

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
            <span className={premiumBps > 0 && quote.side === 'buy' ? 'k warn-text' : 'k'}>
              Fee · {(quote.side === 'buy' ? chargedBps : baseBps) / 100}%
            </span>
            <span className={premiumBps > 0 && quote.side === 'buy' ? 'v mono warn-text' : 'v mono'}>
              {fmt(
                quote.side === 'buy' ? quote.fee + (quote.earlyFeePremium ?? 0n) : quote.fee,
                18,
                6,
              )}{' '}
              {NETWORK.quoteSymbol}
            </span>
          </div>
          {premiumBps > 0 && quote.side === 'buy' && decaySecondsLeft !== null && (
            /*
             * Named, timed, and attributed. A higher fee with no explanation reads as
             * the creator taking more, which is the opposite of what this does: the
             * premium goes into the pool at graduation. The countdown is the point of
             * the rule, so it is shown rather than buried in the rules panel.
             */
            <p className="note warn-text">
              Opening fee: {(premiumBps / 100).toFixed(2)}% above the curve&rsquo;s{' '}
              {(baseBps / 100).toFixed(2)}%, falling to it in{' '}
              {decaySecondsLeft >= 60
                ? `${Math.ceil(decaySecondsLeft / 60)} min`
                : `${decaySecondsLeft}s`}
              . It goes into the pool at graduation, not to the creator, and sells are
              not affected.
            </p>
          )}
                    {(
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
                {quote.side === 'buy' ? 'Price impact' : 'Below spot'}
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
              {quote.side === 'buy'
                ? 'At this size most of what you spend goes into the curve rather than into tokens. The curve is steepest at the start, so a smaller buy pays a much better price.'
                : 'At this size the curve pays well under the quoted spot price. Selling in smaller pieces recovers more, because each sale moves the price against the next one.'}
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
