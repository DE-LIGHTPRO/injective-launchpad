'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { CurveChart } from './CurveChart';
import {
  toCandles,
  candleLayout,
  candleScale,
  priceTicks,
  defaultTimeframe,
  timeframeSeconds,
  TIMEFRAMES,
  type Candle,
  type TimeframeId,
  type CandleGeometry,
} from '@/lib/candles';
import { fmt } from '@/lib/curve';
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
  totalSupplyTokens,
  tradedOnChain,
}: {
  series: Series;
  config: CurveConfig;
  state: CurveState;
  quoteLabel: string;
  quoteDecimals: number;
  sym: string;
  /** Change across the series in bps, or null when there is nothing to compare. */
  change: number | null;
  /** Whole tokens in existence, which turns a fill price into a market cap. */
  totalSupplyTokens: number;
  /**
   * `hasEverTraded(detail)`. An empty series means no history was READ, which is not
   * the same as nothing having happened, and this chart cannot tell the two apart on
   * its own. Resolved once by the page and passed in so that this and the trade list
   * cannot disagree about it.
   */
  tradedOnChain: boolean;
}) {
  const hasTrades = series.points.some((p) => p.time > 0);
  const [view, setView] = useState<'price' | 'curve'>(hasTrades ? 'price' : 'curve');
  const titleId = useId();

  return (
    <div className="card">
      <div className="chart-head">
        <h2 id={titleId}>{view === 'price' ? 'Chart' : 'Bonding curve'}</h2>
        <div className="chart-tabs" role="tablist" aria-label="Chart">
          {/*
              Disabled rather than hidden when there is nothing to plot. Hiding it
              would leave a reader wondering whether this launchpad has a price chart
              at all; disabled with a title says why.

              AND THE TITLE SAID THE WRONG WHY. It read "No trades yet" whenever the
              series was empty, which conflates a launch nobody has bought with one
              whose history the answering node has pruned. On the live testnet that was
              every launch there, including a graduated one with the whole curve supply
              sold. An empty series is an absence of DATA; `tradedOnChain` is the
              absence of TRADES, and only the second one is this sentence.
            */}
          <button
            role="tab"
            type="button"
            aria-selected={view === 'price'}
            className={`chart-tab ${view === 'price' ? 'on' : ''}`}
            disabled={!hasTrades}
            title={
              hasTrades
                ? undefined
                : tradedOnChain
                  ? 'No fill history could be read for this launch'
                  : 'No trades yet'
            }
            onClick={() => setView('price')}
          >
            Market
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
          quoteDecimals={quoteDecimals}
          sym={sym}
          change={change}
          totalSupplyTokens={totalSupplyTokens}
          tradedOnChain={tradedOnChain}
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

/**
 * Whether the browser has taken over, so local time may be rendered.
 *
 * THE DEFECT THIS EXISTS FOR. The axis and the OHLC row formatted times with
 * `toLocaleTimeString`, which uses the RUNTIME's locale and timezone. The server
 * rendered `23:55` and the browser rendered `11:55 PM` for the same candle, so React
 * threw a hydration mismatch and regenerated the whole tree on the client.
 *
 * A time is still shown in the reader's own zone, because a chart is read against
 * the clock on their wall. It just cannot be shown until there IS a reader: both
 * renders agree on the UTC form, and an effect swaps in the local one afterwards.
 */
function useLocalTime(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

/** Dimensions in the SVG's own units. The element scales; these set the proportions. */
const W = 760;
/** The price pane. */
const PRICE_H = 250;
/** The volume pane under it, and the gap between the two. */
const VOL_H = 52;
const GAP = 8;
/** Room under the volume pane for the time axis. */
const AXIS_H = 18;
/** Room on the right for the value axis, which sits outside the plot. */
const AXIS_W = 70;
const H = PRICE_H + GAP + VOL_H + AXIS_H;
const PLOT_W = W - AXIS_W;

/** What the vertical axis measures. */
type Mode = 'mcap' | 'price';

function Candles({
  series,
  quoteLabel,
  quoteDecimals,
  sym,
  change,
  totalSupplyTokens,
  tradedOnChain,
  labelledBy,
}: {
  series: Series;
  quoteLabel: string;
  quoteDecimals: number;
  sym: string;
  change: number | null;
  totalSupplyTokens: number;
  /** See `PriceChart`: an empty series is unread history, not an untraded launch. */
  tradedOnChain: boolean;
  labelledBy: string;
}) {
  /*
   * The reader's choice wins; `null` means they have not made one and the data
   * picks. Kept as null rather than seeded with the default so that new trades
   * arriving re-derive it instead of freezing whatever suited the first render.
   */
  const [chosen, setChosen] = useState<TimeframeId | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /*
   * MARKET CAP LEADS, and that is the launchpad convention rather than a whim. A
   * fill price on a 1e9 supply is a number like 6.4e-7, which nobody holds an
   * opinion about; the same thing as a market cap is 640, which a reader can compare
   * against every other launch on the board. Both are the same measurement scaled by
   * a constant, so the candles are identical in shape and only the axis changes.
   */
  const [mode, setMode] = useState<Mode>('mcap');
  const local = useLocalTime();

  const auto = useMemo(() => defaultTimeframe(series), [series]);
  const tf = chosen ?? auto;
  const interval = timeframeSeconds(tf, series);

  const candles = useMemo(() => toCandles(series, interval), [series, interval]);
  /*
   * Scaling the CANDLES rather than the axis labels. The alternative is to draw
   * prices and relabel the ticks, which silently breaks the moment anything reads a
   * candle's own numbers: the OHLC row, the hover readout and the aria description
   * would all still be in the other unit.
   */
  const scaled = useMemo(
    () => (mode === 'price' ? candles : candles.map((c) => asMarketCap(c, totalSupplyTokens))),
    [candles, mode, totalSupplyTokens],
  );

  const layout = useMemo(
    () => candleLayout(scaled, PLOT_W, PRICE_H, interval),
    [scaled, interval],
  );
  const scale = useMemo(() => candleScale(scaled, PRICE_H), [scaled]);

  if (scaled.length === 0) {
    return (
      <>
        <ChartBar
          mode={mode}
          onMode={setMode}
          tf={tf}
          auto={auto}
          onPick={setChosen}
          summary={null}
        />
        <p className="note">
          {tradedOnChain
            ? 'This launch has traded, but no fill history could be read for it. The node that answered keeps a window of recent blocks, so trades older than that window are not in its transaction search.'
            : 'Nothing has traded yet, so there is no price history to draw.'}
        </p>
      </>
    );
  }

  const ticks = priceTicks(scale, 6);
  const last = scaled[scaled.length - 1];
  const lastY = scale.y(last.close);
  const shown: CandleGeometry | null =
    hover === null ? null : (layout.find((c) => c.candle.time === hover) ?? null);
  const read = shown?.candle ?? last;

  const val = (v: number) => (mode === 'mcap' ? compactValue(v) : significant(v));
  const unit = mode === 'mcap' ? quoteLabel : `${quoteLabel} / ${sym}`;
  const trades = scaled.reduce((n, c) => n + c.trades, 0);
  const volume = scaled.reduce((v, c) => v + c.volume, 0n);

  return (
    <div className="chart">
      <ChartBar
        mode={mode}
        onMode={setMode}
        tf={tf}
        auto={auto}
        onPick={setChosen}
        summary={`${trades} ${trades === 1 ? 'trade' : 'trades'} · ${fmt(volume, quoteDecimals, 3)} ${quoteLabel}`}
      />

      {/*
          The pair, the interval and OHLC on one line, the way every chart does it.
          It reads the candle under the pointer and falls back to the last, so the
          same row serves as both the current quote and the hover readout. Text
          rather than a floating tooltip: a tooltip has to be positioned against a
          scaling SVG and is unreachable on a touch screen.
        */}
      <div className="chart-ohlc mono">
        <strong>
          {sym}/{quoteLabel}
        </strong>
        <span className="chart-ohlc-tf">{tf}</span>
        <span>
          <i>O</i>
          {val(read.open)}
        </span>
        <span>
          <i>H</i>
          {val(read.high)}
        </span>
        <span>
          <i>L</i>
          {val(read.low)}
        </span>
        <span className={read.close >= read.open ? 'up' : 'down'}>
          <i>C</i>
          {val(read.close)}
        </span>
        {change !== null && (
          <span className={`chart-change ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}
            {(change / 100).toFixed(2)}%
          </span>
        )}
        <time dateTime={new Date(read.time * 1000).toISOString()}>
          {stamp(read.time, interval, local)}
        </time>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-labelledby={labelledBy}
        aria-describedby={`${labelledBy}-desc`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Stated for a screen reader, which cannot read a drawing. */}
        <desc id={`${labelledBy}-desc`}>
          {scaled.length} candles of {mode === 'mcap' ? 'market cap' : 'fill prices'} on a{' '}
          {tf} interval, from {val(scale.lo)} to {val(scale.hi)} {unit}.
        </desc>

        {ticks.map((t, i) => {
          const y = scale.y(t);
          return (
            <g key={`tick-${i}`}>
              <line
                x1="0"
                x2={PLOT_W}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={PLOT_W + 8}
                y={y + 3}
                fill="var(--text-faint)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {val(t)}
              </text>
            </g>
          );
        })}

        {layout.map((c) => (
          <g key={c.candle.time} style={{ fill: c.up ? 'var(--buy)' : 'var(--danger)' }}>
            {/* Wick first, so the body paints over its middle. */}
            <rect x={c.cx - 0.5} y={c.wickTop} width="1" height={c.wickH} />
            <rect x={c.x} y={c.bodyTop} width={c.w} height={c.bodyH} />
            {/* The volume bar, in the pane below, on the same slot and colour. */}
            <rect
              x={c.x}
              y={PRICE_H + GAP + VOL_H - Math.max(1, c.volFrac * VOL_H)}
              width={c.w}
              height={Math.max(1, c.volFrac * VOL_H)}
              opacity="0.5"
            />
          </g>
        ))}

        {/* The last close, carried across the plot: the one value a reader looks for. */}
        <line
          x1="0"
          x2={PLOT_W}
          y1={lastY}
          y2={lastY}
          stroke={last.close >= last.open ? 'var(--buy)' : 'var(--danger)'}
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.8"
        />
        {/* and its value as a tag on the axis, which is where the eye goes for it. */}
        <g>
          <rect
            x={PLOT_W + 2}
            y={lastY - 8}
            width={AXIS_W - 4}
            height="16"
            rx="2"
            fill={last.close >= last.open ? 'var(--buy)' : 'var(--danger)'}
          />
          <text
            x={PLOT_W + 6}
            y={lastY + 4}
            fill="var(--on-accent)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {val(last.close)}
          </text>
        </g>

        {shown && (
          <>
            <line
              x1={shown.cx}
              x2={shown.cx}
              y1="0"
              y2={PRICE_H + GAP + VOL_H}
              stroke="var(--text-faint)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            {/* The crosshair's own time, so the reader knows which bar they are on. */}
            <text
              x={Math.min(Math.max(shown.cx, 34), PLOT_W - 34)}
              y={H - 5}
              textAnchor="middle"
              fill="var(--text)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {stamp(shown.candle.time, interval, local)}
            </text>
          </>
        )}

        {/* Time labels, hidden while the crosshair is showing its own. */}
        {!shown &&
          axisLabels(layout).map(({ cx, time }) => (
            <text
              key={`t-${time}`}
              x={Math.min(Math.max(cx, 34), PLOT_W - 34)}
              y={H - 5}
              textAnchor="middle"
              fill="var(--text-faint)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {stamp(time, interval, local)}
            </text>
          ))}

        {/*
            Hit targets last, so they sit above everything and cover the whole slot
            including the gaps. Transparent rather than `pointer-events` juggling:
            one rect per candle is cheap and makes the hover area the slot a reader
            aims at rather than the two-pixel body.
          */}
        {layout.map((c) => (
          <rect
            key={`hit-${c.candle.time}`}
            x={c.cx - c.slot / 2}
            y="0"
            width={c.slot}
            height={PRICE_H + GAP + VOL_H}
            fill="transparent"
            onMouseEnter={() => setHover(c.candle.time)}
          />
        ))}
      </svg>

      <p className="note chart-foot-note">
        {mode === 'mcap' ? 'Market cap' : 'Fill prices'} from real trades. A fill
        includes the fee and the trade&rsquo;s own price impact, so it is what someone
        actually paid rather than the spot price.
      </p>
    </div>
  );
}

/** Mode on the left, intervals and the interval's own totals on the right. */
function ChartBar({
  mode,
  onMode,
  tf,
  auto,
  onPick,
  summary,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  tf: TimeframeId;
  auto: TimeframeId;
  onPick: (id: TimeframeId) => void;
  summary: string | null;
}) {
  return (
    <div className="chart-bar">
      <div className="tf-row" role="group" aria-label="Axis">
        {(['mcap', 'price'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`tf-btn wide ${mode === m ? 'on' : ''}`}
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
          >
            {m === 'mcap' ? 'Mcap' : 'Price'}
          </button>
        ))}
      </div>

      {/*
          EVERY INTERVAL IS OFFERED, including ones that give this launch a thin
          chart. Hiding the unsuitable ones would make the control change shape as
          trades arrive, and a reader comparing two launches would find different
          buttons on each.
        */}
      <div className="tf-row" role="group" aria-label="Candle interval">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tf-btn ${tf === t.id ? 'on' : ''}`}
            aria-pressed={tf === t.id}
            // Named so a reader knows which one the chart chose for them.
            title={t.id === auto ? 'Chosen to suit this launch' : undefined}
            onClick={() => onPick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {summary && <span className="mono chart-summary">{summary}</span>}
    </div>
  );
}

/**
 * The same candle measured as a market cap.
 *
 * Price times the whole supply, which is a constant, so the candle's SHAPE is
 * untouched and only the numbers move. Volume is left alone: it is an amount of
 * quote that changed hands and is not a per-token figure to rescale.
 */
function asMarketCap(c: Candle, totalSupplyTokens: number): Candle {
  return {
    ...c,
    open: c.open * totalSupplyTokens,
    high: c.high * totalSupplyTokens,
    low: c.low * totalSupplyTokens,
    close: c.close * totalSupplyTokens,
  };
}

/** A market cap, in the quote's own units, short enough to sit on an axis. */
function compactValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return significant(v);
}

/**
 * Significant figures rather than a fixed decimal count. A launch opens around
 * 1e-7 quote per token and a graduated one can be orders of magnitude higher, so a
 * `toFixed` that suits one prints `0.0000` for the other.
 */
function significant(v: number): string {
  return v === 0 ? '0' : v.toPrecision(4);
}

/**
 * Up to three time labels: first, middle, last.
 *
 * Not one per candle. At forty candles the labels overlap into an unreadable smear,
 * and rotating them costs more height than the information is worth on a chart this
 * size. The crosshair is how a reader gets an exact time for a specific bar.
 */
function axisLabels(layout: CandleGeometry[]): Array<{ cx: number; time: number }> {
  if (layout.length === 0) return [];
  const pick = [0, Math.floor((layout.length - 1) / 2), layout.length - 1];
  const seen = new Set<number>();
  return pick
    .filter((i) => {
      if (seen.has(i)) return false;
      seen.add(i);
      return true;
    })
    .map((i) => ({ cx: layout[i].cx, time: layout[i].candle.time }));
}

/**
 * A timestamp at the precision the interval justifies.
 *
 * A 1m candle labelled with only a date says nothing; a 1D candle labelled to the
 * minute claims a precision the bucket does not have.
 */
function stamp(seconds: number, interval: number, local: boolean): string {
  const d = new Date(seconds * 1000);
  /*
   * UTC until the browser has taken over. Both renders have to produce the same
   * string or React regenerates the tree, and `toLocale*` reads the runtime's locale
   * and zone, which the server's and the reader's do not share.
   */
  const opts: Intl.DateTimeFormatOptions = local ? {} : { timeZone: 'UTC' };
  const locale = local ? undefined : 'en-GB';
  if (interval >= 86_400) {
    return d.toLocaleDateString(locale, { ...opts, month: 'short', day: 'numeric' });
  }
  if (interval >= 3_600) {
    return d.toLocaleString(locale, { ...opts, month: 'short', day: 'numeric', hour: '2-digit' });
  }
  return d.toLocaleTimeString(locale, { ...opts, hour: '2-digit', minute: '2-digit' });
}
