'use client';

import { useId, useState } from 'react';
import { CurveChart } from './CurveChart';
import { toCandles, candleLayout, candleScale, priceTicks } from '@/lib/candles';
import type { Series } from '@/lib/priceSeries';
import type { CurveConfig, CurveState } from '@/lib/curve';

/**
 * The launch's chart: what people have paid, with what the contract will charge
 * one click away.
 *
 * CANDLES ARE THE DEFAULT AND THE BONDING CURVE IS THE SECOND VIEW. It was the other
 * way round: the bonding curve took the top of the page at full size and the candles
 * were a 60-pixel strip inside the trades card underneath it. The curve is the more
 * interesting object and it is the wrong headline. It is a property of the contract,
 * identical in shape on every launch here, and it does not change when the market
 * does; somebody opening a token's page is asking what it has been doing, and that
 * question has one conventional answer on every trading surface there is.
 *
 * So the curve stays, because it answers a real question no order book can ("what
 * will the next buy cost, and how far is graduation"), and it stops being the thing
 * that greets you.
 *
 * WITH NO TRADES THE CURVE LEADS, because an empty candle chart is worse than no
 * chart: it is a box saying nothing on a page whose job is to say what is known. The
 * curve is meaningful from the moment a launch exists.
 *
 * FILLS, NOT SPOT, and the label says so. A fill includes the fee and the buyer's own
 * price impact, so on a steep curve a large buy prints well above spot. A chart drawn
 * from spot would hide exactly that, which is the thing a buyer most needs to see
 * before placing a large order.
 */
export function PriceChart({
  series,
  config,
  state,
  quoteLabel,
  quoteDecimals,
  sym,
  change,
}: {
  series: Series;
  config: CurveConfig;
  state: CurveState;
  quoteLabel: string;
  quoteDecimals: number;
  sym: string;
  /** Change across the series in bps, or null when there is nothing to compare. */
  change: number | null;
}) {
  const hasTrades = series.points.length > 0;
  const [view, setView] = useState<'price' | 'curve'>(hasTrades ? 'price' : 'curve');
  const titleId = useId();

  return (
    <div className="card">
      <div className="chart-head">
        <h2 id={titleId}>{view === 'price' ? 'Price' : 'Bonding curve'}</h2>
        <div className="chart-tabs" role="tablist" aria-label="Chart">
          {/*
              Disabled rather than hidden when there is nothing to plot. Hiding it
              would leave a reader wondering whether this launchpad has a price chart
              at all; disabled with a title says the launch has not traded yet, which
              is the actual answer.
            */}
          <button
            role="tab"
            type="button"
            aria-selected={view === 'price'}
            className={`chart-tab ${view === 'price' ? 'on' : ''}`}
            disabled={!hasTrades}
            title={hasTrades ? undefined : 'No trades yet'}
            onClick={() => setView('price')}
          >
            Price
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={view === 'curve'}
            className={`chart-tab ${view === 'curve' ? 'on' : ''}`}
            onClick={() => setView('curve')}
          >
            Curve
          </button>
        </div>
      </div>

      {view === 'price' ? (
        <Candles
          series={series}
          quoteLabel={quoteLabel}
          sym={sym}
          change={change}
          labelledBy={titleId}
        />
      ) : (
        <>
          <CurveChart
            config={config}
            state={state}
            quoteLabel={quoteLabel}
            quoteDecimals={quoteDecimals}
            height={220}
          />
          <p className="note">
            What the contract will charge, not what anyone has paid. Every launch here
            uses this same shape; the marker is where this one has reached.
          </p>
        </>
      )}
    </div>
  );
}

/** Dimensions in the SVG's own units. The element scales; these set the proportions. */
const W = 560;
const H = 220;
const PAD_T = 8;
const PAD_B = 18;
/** Room on the right for the price axis, which sits outside the plot. */
const AXIS_W = 62;

function Candles({
  series,
  quoteLabel,
  sym,
  change,
  labelledBy,
}: {
  series: Series;
  quoteLabel: string;
  sym: string;
  change: number | null;
  labelledBy: string;
}) {
  /*
   * 40 buckets at this width gives bodies around 8px, which is the density a reader
   * can still pick a single candle out of. `toCandles` derives the span from the
   * data's own block range, so a launch an hour old and one a week old both fill it.
   */
  const candles = toCandles(series, 40);
  if (candles.length === 0) {
    return <p className="note">Nothing has traded yet, so there is no price history to draw.</p>;
  }

  const plotH = H - PAD_T - PAD_B;
  const scale = candleScale(candles, plotH, 0);
  const layout = candleLayout(candles, W - AXIS_W, plotH, 0);
  const ticks = priceTicks(scale, 5);
  const last = candles[candles.length - 1];
  const lastY = PAD_T + scale.y(last.close);

  /*
   * Significant figures rather than a fixed decimal count. A launch opens around
   * 1e-8 quote per token and a graduated one can be orders of magnitude higher, so a
   * `toFixed` that suits one prints `0.0000` for the other.
   */
  const price = (v: number) => (v === 0 ? '0' : v.toPrecision(3));

  return (
    <div className="chart">
      <div className="chart-meta">
        <span className="mono chart-last">
          {price(last.close)} <span className="chart-unit">{quoteLabel} per {sym}</span>
        </span>
        {change !== null && (
          <span className={`mono chart-change ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}
            {(change / 100).toFixed(2)}%
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-labelledby={labelledBy}
        aria-describedby={`${labelledBy}-desc`}
        preserveAspectRatio="none"
      >
        {/* Stated for a screen reader, which cannot read a drawing. */}
        <desc id={`${labelledBy}-desc`}>
          {candles.length} candles of fill prices across {series.points.length} trades,
          from {price(scale.lo)} to {price(scale.hi)} {quoteLabel} per {sym}.
        </desc>

        {ticks.map((t, i) => {
          const y = PAD_T + scale.y(t);
          return (
            <g key={i}>
              <line
                x1="0"
                x2={W - AXIS_W}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={W - AXIS_W + 8}
                y={y + 3}
                fill="var(--text-faint)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {price(t)}
              </text>
            </g>
          );
        })}

        {layout.map((c, i) => (
          <g key={i} style={{ fill: c.up ? 'var(--accent)' : 'var(--danger)' }}>
            {/* Wick first, so the body paints over its middle. */}
            <rect x={c.x + c.w / 2 - 0.5} y={PAD_T + c.wickTop} width="1" height={c.wickH} />
            <rect x={c.x} y={PAD_T + c.bodyTop} width={c.w} height={c.bodyH} rx="1" />
          </g>
        ))}

        {/* The last close, carried across the plot: the one price a reader looks for. */}
        <line
          x1="0"
          x2={W - AXIS_W}
          y1={lastY}
          y2={lastY}
          stroke="var(--accent)"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.7"
        />
      </svg>

      {/*
          BLOCKS, not a time range. Height is the only ordering the transaction log
          gives a trade, so a wall-clock axis would be a derived number wearing a
          precise label. Stated in the footer rather than under the axis, because
          every candle is a block span and the two ends are what a reader uses.
        */}
      <div className="chart-foot mono">
        <span>block {candles[0].from.toLocaleString('en-US')}</span>
        <span className="note">
          fill prices, {candles.length} {candles.length === 1 ? 'candle' : 'candles'} by block
        </span>
        <span>{last.to.toLocaleString('en-US')}</span>
      </div>
    </div>
  );
}
