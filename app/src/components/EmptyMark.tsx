/**
 * The mark an empty page shows, one per page rather than one reused.
 *
 * WHY THREE AND NOT ONE. The obvious move is a single handsome asset on every empty
 * state, and the site this was measured against does exactly that: its Watchlist,
 * Portfolio and Claim pages show the identical rendered coin. It looks good once and
 * then says nothing - the picture is the same whether you have starred nothing, hold
 * nothing, or have earned nothing, which are three different situations with three
 * different things to do next.
 *
 * So each page gets a mark about its own absence, and they share a language rather than
 * a file: the same stroke weight, the same accent, the same soft floor-glow, and the
 * curve running behind each one because the curve is what this product is. A system,
 * which is the thing a repeated asset only looks like.
 *
 * DRAWN RATHER THAN GENERATED, for the reason `StepArt` gives and one more: these are
 * small, they sit on a dark panel, and they must stay crisp while a raster at this size
 * either blurs or ships four times the bytes for one decorative element.
 *
 * `aria-hidden` throughout. Every one sits directly above a heading that says the same
 * thing in words, so announcing it reads the state twice.
 */

const LINE = {
  fill: 'none',
  stroke: 'var(--accent)',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** The soft light under each mark, which is what gives a flat drawing depth. */
function Floor({ id }: { id: string }) {
  return (
    <>
      <defs>
        <radialGradient id={id} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="74" rx="40" ry="7" fill={`url(#${id})`} />
    </>
  );
}

/** Nothing starred: an outlined star, with the curve it would have been starred from. */
export function MarkStar() {
  return (
    <svg className="empty-mark" viewBox="0 0 120 88" aria-hidden="true">
      <Floor id="em-star" />
      <path d="M12 60 Q46 60 70 40 T110 16" {...LINE} opacity="0.3" />
      <path
        d="M60 22 l6.8 13.8 15.2 2.2-11 10.7 2.6 15.1L60 56.7 46.4 63.8 49 48.7l-11-10.7 15.2-2.2z"
        {...LINE}
      />
    </svg>
  );
}

/** Nothing held: two discs, one empty outline where a holding would sit. */
export function MarkHoldings() {
  return (
    <svg className="empty-mark" viewBox="0 0 120 88" aria-hidden="true">
      <Floor id="em-hold" />
      <path d="M12 62 Q48 62 72 42 T110 18" {...LINE} opacity="0.3" />
      <ellipse cx="60" cy="56" rx="22" ry="7" {...LINE} opacity="0.55" />
      <ellipse cx="60" cy="44" rx="22" ry="7" {...LINE} opacity="0.75" />
      {/* The top disc is open, because this is the one that is not there yet. */}
      <ellipse cx="60" cy="32" rx="22" ry="7" {...LINE} strokeDasharray="4 4" />
      <path d="M38 44 V56 M82 44 V56" {...LINE} opacity="0.55" />
    </svg>
  );
}

/** Nothing to claim: a fee that has not fallen into the tray yet. */
export function MarkFees() {
  return (
    <svg className="empty-mark" viewBox="0 0 120 88" aria-hidden="true">
      <Floor id="em-fees" />
      <path d="M12 60 Q46 60 70 40 T110 16" {...LINE} opacity="0.3" />
      {/* The tray, open at the top: it can receive, and holds nothing. */}
      <path d="M38 52 v10 a4 4 0 0 0 4 4 h36 a4 4 0 0 0 4-4 V52" {...LINE} />
      <circle cx="60" cy="30" r="11" {...LINE} />
      {/* Dashed, because the drop is the thing that has not happened. */}
      <path d="M60 42 V50" {...LINE} strokeDasharray="3 3" opacity="0.6" />
    </svg>
  );
}
