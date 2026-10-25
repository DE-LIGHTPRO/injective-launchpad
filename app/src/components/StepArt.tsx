/**
 * The three steps of a launch, drawn.
 *
 * WHY DRAWN RATHER THAN GENERATED. These are diagrams, not decoration: each one says
 * something the sentence beside it also says, so they have to be ACCURATE, and an image
 * model cannot be held to that. The second one is the product's actual curve shape; a
 * generated "bonding curve" would be a plausible squiggle. Line art in the page's own
 * accent colour also costs nothing to ship, themes with the rest of the interface, and
 * stays sharp at any size, none of which is true of a raster.
 *
 * `aria-hidden` on all three. Each sits directly above a heading and a sentence that
 * carry the same meaning in words, so announcing them would read the step twice.
 */

const STROKE = { fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** A supply handed to a contract: a token, and the curve it goes into. */
export function StepCreate() {
  return (
    <svg className="step-art" viewBox="0 0 96 48" aria-hidden="true">
      <circle cx="16" cy="24" r="9" fill="var(--accent)" opacity="0.9" />
      {/* Dashed, because the handover is the step rather than a thing that exists. */}
      <path d="M30 24 H56" {...STROKE} strokeDasharray="3 3" opacity="0.6" />
      <rect x="62" y="8" width="30" height="30" rx="8" {...STROKE} opacity="0.5" />
      <path d="M68 32 Q78 32 86 15" {...STROKE} />
    </svg>
  );
}

/**
 * Trading along the curve, with a buyer's position on it.
 *
 * The path is convex and rising because that is what this product's curve does: each
 * buy costs more than the one before it. Drawing a straight line or an S would
 * illustrate a different instrument.
 */
export function StepTrade() {
  return (
    <svg className="step-art" viewBox="0 0 96 48" aria-hidden="true">
      <path d="M8 42 Q46 42 60 24 T88 8" {...STROKE} opacity="0.35" />
      <path d="M8 42 Q38 42 54 28" {...STROKE} />
      <circle cx="54" cy="28" r="4.5" fill="var(--accent)" />
      <circle cx="54" cy="28" r="9" {...STROKE} opacity="0.35" />
    </svg>
  );
}

/** Liquidity that locks itself: a closed ring with no way out of it. */
export function StepGraduate() {
  return (
    <svg className="step-art" viewBox="0 0 96 48" aria-hidden="true">
      <circle cx="48" cy="24" r="17" {...STROKE} opacity="0.45" />
      {/* A shackle and a closed body. No keyhole: there is no key. */}
      <path d="M42 20 V16 a6 6 0 0 1 12 0 v4" {...STROKE} />
      <rect x="39" y="20" width="18" height="14" rx="3" {...STROKE} />
    </svg>
  );
}
