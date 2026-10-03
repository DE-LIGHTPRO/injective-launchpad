'use client';

import { curvePoints, graduationProgress, type CurveConfig, type CurveState } from '@/lib/curve';

const ONE = 1_000_000_000_000_000_000n;

/**
 * Price against INJ raised, drawn straight from the curve config so the shape
 * shown is the shape the contract will actually charge. The marker is where
 * this launch currently sits.
 */
export function CurveChart({
  config,
  state,
  height = 180,
}: {
  config: CurveConfig;
  state: CurveState;
  height?: number;
}) {
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

  const progress = graduationProgress(config, state);
  const hereX = x(maxX * progress);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Bonding curve">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00d6a4" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#00d6a4" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="#222838" strokeWidth="1" />
      <path d={area} fill="url(#fill)" />
      <path d={line} fill="none" stroke="#00d6a4" strokeWidth="2" strokeLinejoin="round" />

      {/* where this launch currently is */}
      <line x1={hereX} y1={pad.t} x2={hereX} y2={H - pad.b} stroke="#f0a44a" strokeWidth="1" strokeDasharray="3 3" />
      <circle cx={hereX} cy={y(points[Math.round(progress * (points.length - 1))]?.price ?? 0)} r="4" fill="#f0a44a" />

      <text x={pad.l} y={H - 5} fill="#7d879e" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
        0 INJ raised
      </text>
      <text x={W - pad.r} y={H - 5} fill="#7d879e" fontSize="10" textAnchor="end" fontFamily="ui-monospace, Menlo, monospace">
        {maxX.toFixed(1)} INJ
      </text>
    </svg>
  );
}
