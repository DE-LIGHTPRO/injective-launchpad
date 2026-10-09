/**
 * The mark: the curve itself.
 *
 * `inj·pad` was wordmark-only, which is what a project has before anyone has decided
 * what it looks like. The product's one distinctive thing is that every launch is a
 * bonding curve, so the mark is that shape rather than a coin, a rocket or an abstract
 * polygon, all of which would say "crypto app" and nothing else.
 *
 * Drawn with the same exponent as the real curve (x squared against a virtual reserve),
 * so it is the family of shape the product actually produces rather than an arbitrary
 * swoosh that happens to curve.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="brand-mark"
    >
      {/* The axes, understated: they place the curve without competing with it. */}
      <path d="M3 21 H21" stroke="currentColor" strokeWidth="1.25" opacity="0.28" strokeLinecap="round" />
      <path d="M3 21 V3" stroke="currentColor" strokeWidth="1.25" opacity="0.28" strokeLinecap="round" />
      {/* The curve, and the point on it: a launch is always somewhere along one. */}
      <path
        d="M3.5 20.5 C9 20 14 16.5 20.5 4"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="14" cy="16.4" r="2.1" fill="var(--warn)" />
    </svg>
  );
}
