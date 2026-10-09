import { curvePoints, chartMarker, type CurveConfig, type CurveState } from '@/lib/curve';

const ONE_TOKEN = 10n ** 18n;

/**
 * A launch's own curve, small enough to sit in a card.
 *
 * This product's whole identity is the shape. Every launch IS a curve, and the card
 * for one was showing a progress bar, which is what every list of anything shows. Two
 * launches at 40% looked identical when their curves are different objects: a steep
 * one is a launch where the next buyer pays sharply more, a flat one is not, and that
 * is the single most useful thing to know before clicking.
 *
 * So this is not decoration standing in for data. It is drawn from `curvePoints`, the
 * same function the full chart uses, and the marker is `chartMarker`, the same one the
 * launch page uses, so a card and the page it opens cannot disagree about where a
 * launch sits.
 *
 * `preserveAspectRatio="none"` on purpose: the vertical axis is price and the
 * horizontal is quote raised, two unrelated units, so there is no aspect to preserve
 * and letting it stretch is what makes the shape readable at any card width.
 */
export function CurveGlyph({
  config,
  state,
  height = 44,
  showMarker = true,
}: {
  config: CurveConfig;
  state: CurveState;
  height?: number;
  showMarker?: boolean;
}) {
  const W = 120;
  const H = height;
  const PAD = 2;

  /*
   * `curvePoints` returns plain numbers in whole units, not base units, and takes the
   * token scale rather than an axis maximum. Reading its signature rather than
   * assuming it matched the bigint convention used everywhere else in this file saved
   * drawing a curve out of numbers that were off by eighteen orders of magnitude,
   * which renders as a flat line along the bottom and looks like a launch with no
   * activity rather than like a bug.
   */
  const pts = curvePoints(config, ONE_TOKEN, 40);
  if (pts.length < 2) return null;

  const maxX = pts[pts.length - 1].injRaised;
  const maxY = pts[pts.length - 1].price;
  // A zero span divides by zero and puts NaN in the path, which draws nothing at all
  // rather than failing visibly.
  const spanX = maxX > 0 ? maxX : 1;
  const spanY = maxY > 0 ? maxY : 1;

  const x = (v: number) => PAD + (v / spanX) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / spanY) * (H - PAD * 2);

  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.injRaised).toFixed(1)},${y(p.price).toFixed(1)}`)
    .join(' ');
  // Closed back along the baseline so the area under the curve can be filled, which is
  // what makes the shape legible at 44px rather than a thin squiggle.
  const area = `${line} L${(W - PAD).toFixed(1)},${H} L${PAD},${H} Z`;

  const marker = showMarker ? chartMarker(config, state, maxX, ONE_TOKEN) : null;

  return (
    <svg
      className="curve-glyph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      aria-hidden="true"
    >
      <defs>
        {/*
            The gradient id is derived from the curve's own numbers rather than being a
            constant. Two glyphs on one page with the same id means the second one
            references the first one's definition, and in a list of launches that is
            every card after the first quietly using another launch's fill.
          */}
        <linearGradient id={`cg-${String(config.curveSupply)}-${String(config.graduationTarget)}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.02" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#cg-${String(config.curveSupply)}-${String(config.graduationTarget)})`} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {marker && (
        <>
          {/* Where this launch actually is, which is the point of showing the curve. */}
          <line
            x1={x(marker.injX).toFixed(1)}
            y1={y(marker.price).toFixed(1)}
            x2={x(marker.injX).toFixed(1)}
            y2={H}
            stroke="var(--accent)"
            strokeWidth="1"
            strokeDasharray="2 2"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={x(marker.injX).toFixed(1)} cy={y(marker.price).toFixed(1)} r="2.5" fill="var(--warn)" />
        </>
      )}
    </svg>
  );
}
