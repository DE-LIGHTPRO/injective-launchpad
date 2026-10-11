'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { curvePoints, quoteBuy, spotPrice, fmt, type CurveConfig, type CurveState } from '@/lib/curve';
import { NETWORK } from '@/lib/config';

/**
 * The curve, as something you can move along.
 *
 * Every launchpad's homepage is a board of other people's tokens. Nearly's signature
 * is split-flap digits, Pons's is restraint, and copying either would make this a
 * third version of someone else's page. The thing only this product has is that every
 * launch IS a curve, so the hero is one you can actually interrogate.
 *
 * It answers the question a newcomer cannot otherwise get answered: what does a
 * bonding curve mean for the price I pay? Drag along it and the quote changes. There
 * is no copy that does this as well as moving the handle once.
 *
 * EVERY NUMBER IS REAL. `quoteBuy` is the same function the trade panel uses and the
 * same arithmetic the contract runs, on the default shape a new launch gets. It is a
 * simulation of a launch that does not exist, which the caption says, but it is not
 * an illustration: the figures are what that launch would actually charge.
 */

const ONE = 10n ** 18n;

/** The shape a launch starts from on the create form. */
const SHAPE: CurveConfig = {
  virtualInj: 30n * ONE,
  virtualTokens: 1_073_000_000n * ONE,
  curveSupply: 800_000_000n * ONE,
  graduationTarget: 85n * ONE,
  feeBps: 100n,
};

const W = 760;
const H = 260;
const PAD = 28;

export function CurveExplorer() {
  // Position along the curve, 0 to 1 of the graduation target.
  const [t, setT] = useState(0.18);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const pts = useMemo(() => curvePoints(SHAPE, ONE, 80), []);
  const maxX = pts[pts.length - 1].injRaised;
  const maxY = pts[pts.length - 1].price;

  const x = useCallback((v: number) => PAD + (v / (maxX || 1)) * (W - PAD * 2), [maxX]);
  const y = useCallback((v: number) => H - PAD - (v / (maxY || 1)) * (H - PAD * 2), [maxY]);

  const path = useMemo(
    () => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.injRaised).toFixed(1)},${y(p.price).toFixed(1)}`).join(' '),
    [pts, x, y],
  );

  /*
   * The state at this point on the curve, and what one INJ would buy there.
   *
   * Derived from `quoteBuy` rather than read off the drawn points: the line is 80
   * samples and the handle moves continuously, so interpolating between samples would
   * quote a price the contract never would. Recomputing is cheap and exact.
   */
  const at = useMemo(() => {
    const raised = BigInt(Math.round(t * Number(SHAPE.graduationTarget)));
    const state: CurveState = {
      injCollected: raised,
      // Tokens sold follows from the reserve on this curve, which `curvePoints`
      // derives the same way. Approximating it would make the quote disagree with
      // the line it is drawn under.
      tokensSold:
        SHAPE.virtualTokens -
        (SHAPE.virtualInj * SHAPE.virtualTokens) / (SHAPE.virtualInj + raised),
      graduated: false,
    };
    try {
      const q = quoteBuy(SHAPE, state, ONE);
      /*
       * The price comes back with the quote, so the handle and the readout are the
       * same measurement. The first version computed the handle's height from its
       * own copy of the curve formula and got it INVERTED: it used
       * `1/(vi+r)^2`, which falls as reserves rise, where this curve's price rises.
       * The handle floated well above the line at every point but the ends, which
       * reads as a broken chart rather than a misplaced marker.
       */
      return {
        raised,
        tokensPerInj: q.tokensOut,
        price: spotPrice(SHAPE, state, ONE),
        pct: t * 100,
      };
    } catch {
      return null;
    }
  }, [t]);

  const onMove = useCallback((clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Mapped through the rendered width, not the viewBox: the SVG scales to its
    // container, so using W here would mis-track at every size but one.
    const frac = (clientX - r.left) / r.width;
    const inner = (frac * W - PAD) / (W - PAD * 2);
    setT(Math.min(1, Math.max(0, inner)));
  }, []);

  const handleX = x(t * maxX);
  // Plotted in the same units the line is: whole quote per token, from `spotPrice`.
  const handleY = y(at ? Number(at.price) / Number(ONE) : 0);

  return (
    <section className="explorer" aria-labelledby="explorer-heading">
      <div className="explorer-head">
        <h2 id="explorer-heading">The bonding curve</h2>
        <p className="note">Every launch uses this curve. Computed with the contract&rsquo;s own maths.</p>
      </div>

      <svg
        ref={svgRef}
        className="explorer-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="slider"
        tabIndex={0}
        aria-label="Position along the bonding curve"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(t * 100)}
        aria-valuetext={`${(t * 100).toFixed(0)}% to graduation`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onMove(e.clientX);
        }}
        onPointerMove={(e) => {
          // Only while held, so a passing cursor does not drag the handle.
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onMove(e.clientX);
        }}
        /*
         * Keyboard, because a slider that only responds to a pointer is unusable to
         * anyone navigating by keys, and this is the page's main interactive element.
         */
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            setT((v) => Math.min(1, v + step));
            e.preventDefault();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            setT((v) => Math.max(0, v - step));
            e.preventDefault();
          } else if (e.key === 'Home') {
            setT(0);
            e.preventDefault();
          } else if (e.key === 'End') {
            setT(1);
            e.preventDefault();
          }
        }}
      >
        <defs>
          <linearGradient id="explorer-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.02" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        <path d={`${path} L${(W - PAD).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`} fill="url(#explorer-fill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />

        {/* The axis, so the shape is anchored to something. */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line-strong)" strokeWidth="1" />

        <line x1={handleX} y1={handleY} x2={handleX} y2={H - PAD} stroke="var(--warn)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <circle cx={handleX} cy={handleY} r="6" fill="var(--warn)" />
        <circle cx={handleX} cy={handleY} r="11" fill="var(--warn)" opacity="0.18" />

        <text x={PAD} y={H - 8} className="explorer-axis">
          0 {NETWORK.quoteSymbol} raised
        </text>
        <text x={W - PAD} y={H - 8} textAnchor="end" className="explorer-axis">
          {maxX.toFixed(0)} {NETWORK.quoteSymbol} (graduation)
        </text>
      </svg>

      {at && (
        <div className="explorer-read">
          <div>
            <span className="k">Raised</span>
            <span className="v mono">
              {fmt(at.raised, 18, 2)} {NETWORK.quoteSymbol}
            </span>
          </div>
          <div>
            <span className="k">Progress</span>
            <span className="v mono">{at.pct.toFixed(0)}%</span>
          </div>
          <div>
            <span className="k">1 {NETWORK.quoteSymbol} buys</span>
            <span className="v mono">{fmt(at.tokensPerInj, 18, 0)} tokens</span>
          </div>
        </div>
      )}
      <p className="note explorer-hint">
        Drag the handle or use the arrow keys. The further along, the fewer tokens each{' '}
        {NETWORK.quoteSymbol} buys.
      </p>
    </section>
  );
}
