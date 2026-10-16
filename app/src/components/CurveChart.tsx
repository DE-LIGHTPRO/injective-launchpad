'use client';

import { curvePoints, chartMarker, type CurveConfig, type CurveState } from '@/lib/curve';

/**
 * The quote's unit, for turning base units into whole ones on the axis.
 *
 * WAS A CONSTANT 1e18, which is right only while every launch is priced in INJ.
 * Injective's USDC is 6 decimals, so a USDC curve drew an axis running to
 * 0.000000000085, labelled INJ, for a launch that graduates at 85 USDC.
 */
function unitFor(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Price against INJ raised, drawn straight from the curve config so the shape
 * shown is the shape the contract will actually charge. The marker is where this
 * launch currently sits.
 *
 * THE X AXIS RUNS TO `maxCollectable`, NOT TO THE GRADUATION TARGET, and the
 * marker used to ignore the difference. It was positioned at
 * `maxX * graduationProgress`, and `graduationProgress` divides by
 * `graduationTarget` (85) while `maxX` is the curve ceiling (87.91). So the marker
 * sat 3.4% further right than the launch actually was, at every point along the
 * curve, and at graduation it landed on the ceiling rather than on the target it
 * was marking: a launch drawn as past the point it had just graduated at.
 *
 * It is now placed from `injCollected` directly, against the same axis the line is
 * drawn on, and its height comes from `spotPrice` for the real state rather than
 * from indexing the sampled array. Both are the actual values instead of a
 * proportion of something else, which is why they cannot drift apart again.
 */
export function CurveChart({
  config,
  state,
  height = 180,
  quoteLabel,
  quoteDecimals,
}: {
  config: CurveConfig;
  state: CurveState;
  height?: number;
  /**
   * Ticker for the axis. REQUIRED, and it used to default to 'INJ' at 18 decimals.
   *
   * That default was right for the default pair and silently wrong for every other,
   * which made it the trap rather than the convenience: `CreateLaunch` called this
   * component bare, so with the 6-decimal E2EUSD pair selected the axis read
   * `0 INJ raised` and `0.0 INJ` for a curve the row beneath it said tops out at
   * 15,689.37 E2EUSD - the ceiling collapsing to one decimal because a 6-decimal
   * reserve was divided by 1e18. The `unitFor` note below records that same defect as
   * already fixed; the default reinstated it one call site over.
   *
   * Required rather than guarded, because then the compiler refuses the omission and
   * the hazard is gone instead of watched. Every sibling that renders a launch's money
   * (`PriceChart`, `TradeTicker`, `LaunchPreview`) already declared these required.
   */
  quoteLabel: string;
  /** Decimals of that quote, which set the axis scale. */
  quoteDecimals: number;
}) {
  const ONE = unitFor(quoteDecimals);
  let points;
  try {
    points = curvePoints(config, ONE, 70);
  } catch {
    return <div className="note">curve cannot be plotted with these parameters</div>;
  }
  if (points.length < 2) return null;

  const W = 560;
  const H = height;
  const pad = { l: 6, r: 6, t: 10, b: 18 };

  const maxX = points[points.length - 1].injRaised || 1;
  const maxY = Math.max(...points.map((p) => p.price)) || 1;

  const x = (v: number) => pad.l + (v / maxX) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.injRaised).toFixed(2)},${y(p.price).toFixed(2)}`).join(' ');
  const area = `${line} L${x(maxX).toFixed(2)},${H - pad.b} L${x(0).toFixed(2)},${H - pad.b} Z`;

  // Both from `chartMarker`, which is where the positioning lives so that it can be
  // tested by behaviour rather than by reading this file.
  const { injX, price: herePrice } = chartMarker(config, state, maxX, ONE);
  const hereX = x(injX);
  // Graduation happens before the axis ends, so it needs its own mark: without it
  // the chart shows a curve running past a target it never explains.
  const targetInj = Number(config.graduationTarget) / Number(ONE);
  const targetX = x(Math.min(targetInj, maxX));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Bonding curve">
      <defs>
        {/*
            `stopColor` cannot take a var() through a presentation attribute, so the
            gradient carries the accent through `style` like the strokes do.
          */}
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>

      <line
        x1={pad.l}
        y1={H - pad.b}
        x2={W - pad.r}
        y2={H - pad.b}
        style={{ stroke: 'var(--line-strong)' }}
        strokeWidth="1"
      />
      <path d={area} fill="url(#fill)" />
      <path d={line} fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="2" strokeLinejoin="round" />

      {/* Where graduation happens, which is before the axis ends. */}
      <line
        x1={targetX}
        y1={pad.t}
        x2={targetX}
        y2={H - pad.b}
        style={{ stroke: 'var(--line-strong)' }}
        strokeWidth="1"
        strokeDasharray="2 4"
      />

      {/* Where this launch currently is. */}
      <line
        x1={hereX}
        y1={pad.t}
        x2={hereX}
        y2={H - pad.b}
        style={{ stroke: 'var(--warn)' }}
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <circle cx={hereX} cy={y(herePrice)} r="4" style={{ fill: 'var(--warn)' }} />

      <text x={pad.l} y={H - 5} style={{ fill: 'var(--text-faint)' }} fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
        0 {quoteLabel} raised
      </text>
      <text x={W - pad.r} y={H - 5} style={{ fill: 'var(--text-faint)' }} fontSize="10" textAnchor="end" fontFamily="ui-monospace, Menlo, monospace">
        {maxX.toFixed(1)} {quoteLabel}
      </text>
    </svg>
  );
}
