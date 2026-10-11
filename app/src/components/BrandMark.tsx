/**
 * The mark: a tile divided by the bonding curve.
 *
 * The two halves are the pool's two reserves, quote and token, and the line between
 * them is the curve that binds them (x · y = k). It runs flat, rises, and levels off,
 * which is the life of a launch: the curve, then the pool locked at graduation.
 *
 * Drawn on a 32 grid. The channel along the curve is cut with a mask so it is the
 * background showing through, on any background. `id` must be unique per page because
 * SVG ids are document-global; each call site passes its own.
 */
const CURVE = 'M0 23 H6.5 C12 23 13.5 9 19.5 9 H32';

export function BrandMark({ size = 24, id = 'mark' }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <defs>
        <clipPath id={`${id}-tile`}>
          <rect width="32" height="32" rx="8" />
        </clipPath>
        <mask id={`${id}-cut`}>
          <rect width="32" height="32" fill="#fff" />
          <path d={CURVE} stroke="#000" strokeWidth="1.6" fill="none" />
        </mask>
      </defs>
      <g clipPath={`url(#${id}-tile)`} mask={`url(#${id}-cut)`}>
        <rect width="32" height="32" fill="#a9c4ff" />
        <path d={`${CURVE} V32 H0 Z`} fill="#2f6bf0" />
      </g>
    </svg>
  );
}
