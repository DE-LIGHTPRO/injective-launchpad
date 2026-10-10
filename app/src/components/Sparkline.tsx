/**
 * A launch's recent fills, as one line.
 *
 * EVERY POINT IS A REAL TRADE. The series is quote paid over tokens received, so this
 * is what people were actually charged, not the curve formula redrawn. On this
 * contract the two agree, which is why using the fills is safe; it is also why it is
 * the better choice, because a line drawn from the formula would agree with itself
 * forever and could never show a divergence.
 *
 * NO AXES, NO GRID, NO TOOLTIP. It sits in a card at 56 by 20 pixels, where a reader
 * takes one glance and gets direction and roughness. Anything more precise belongs on
 * the launch page, where there is room to label it.
 *
 * It renders NOTHING below two points. A single trade drawn as a line is a flat
 * segment that reads as "this has been stable", when what happened is that it has been
 * traded once.
 */
export function Sparkline({
  series,
  width = 56,
  height = 20,
}: {
  series: number[];
  width?: number;
  height?: number;
}) {
  if (series.length < 2) return null;

  const lo = Math.min(...series);
  const hi = Math.max(...series);
  /*
   * A flat series has no range to normalise against, and dividing by zero puts every
   * point at NaN, which renders as an invisible path rather than as an error. Drawn
   * down the middle instead, which is the honest picture of a price that has not moved.
   */
  const span = hi - lo;
  const y = (v: number) => (span === 0 ? height / 2 : height - ((v - lo) / span) * height);
  const x = (i: number) => (i / (series.length - 1)) * width;

  const d = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // Direction over the window, which is what the colour means. Not a 24h change: the
  // window is however many trades were read, and the card does not claim otherwise.
  // `--ok` / `--err` do not exist in this stylesheet; the tokens are `--accent` and
  // `--danger`. An undefined CSS variable in a `stroke` yields no stroke at all, so
  // the chart would have rendered as empty space with nothing reporting a problem.
  const up = series[series.length - 1] >= series[0];

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={d}
        fill="none"
        stroke={up ? 'var(--accent)' : 'var(--danger)'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
