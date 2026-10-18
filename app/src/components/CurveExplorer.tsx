'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { curvePoints, quoteBuy, chartMarker, stateAtRaised, fmt, type CurveConfig } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { fixedCurveFor, DEFAULT_FEE_BPS } from '@/lib/launchLimits';

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

/**
 * The shape a launch actually gets, read from the one place that defines it.
 *
 * IT USED TO BE A SECOND COPY, written out here as `virtualInj: 30` and
 * `graduationTarget: 85`. When the curve was flattened to 60/170 to halve price
 * impact, the factory changed, `launchLimits.ts` changed, and this did not. The
 * homepage hero then taught every visitor that graduation is 88 INJ when the
 * deployed curve needs about 175, and quoted a token amount for 1 INJ that no
 * launch would ever charge, under a docblock claiming every number is real.
 *
 * Nothing about the page looked wrong, which is the point: a duplicated constant
 * does not drift visibly, it drifts correctly-looking. `fixedCurveFor` is the same
 * function the create form and the quote panel use.
 */
const SHAPE: CurveConfig = {
  ...fixedCurveFor(NETWORK.quoteDecimals),
  // The default a new launch starts from on the form, which the creator may change
  // within the cap. The curve's shape is policy; the fee is not. The form starts both
  // sides at this default, so the page shows the symmetric launch.
  feeBps: BigInt(DEFAULT_FEE_BPS),
  feeSellBps: BigInt(DEFAULT_FEE_BPS),
};

const W = 760;
const H = 260;
const PAD = 28;

export function CurveExplorer() {
  /*
   * Position along the curve as a fraction of the GRADUATION TARGET, which is as far
   * as any launch can travel. NOT a fraction of the axis: the axis runs to the
   * curve's ceiling, which is 3.44% further right.
   *
   * THE TWO BASES WERE MIXED, AND `CurveChart` HAD ALREADY FOUND THIS EXACT DEFECT.
   * Its docblock describes the marker sitting "3.4% further right than the launch
   * actually was, at every point along the curve, and at graduation ... on the ceiling
   * rather than on the target it was marking". The same two numbers were in use here:
   * the handle's x came from `t * maxX` (ceiling, 1980.95) while every figure under it
   * was computed at `t * graduationTarget` (1915).
   *
   * So the handle pointed at one place on the curve and read out the price at another.
   * Measured on the default shape: up to 23.4px apart on a 704px plot, with the price
   * at the drawn position up to 5.16% above the price displayed, and at the far right
   * the readout said 1,915.00 while the handle sat on 1,980.95.
   *
   * Fixed by using `CurveChart`'s own `chartMarker` rather than fixing it a second
   * time here: the handle is placed from `injCollected`, against the same axis the
   * line is drawn on, so the position and the readout are one measurement. Sharing
   * the function is the part that stops this recurring - the fix only failed to
   * reach here the first time because the arithmetic was inlined.
   */
  const [t, setT] = useState(0.18);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const pts = useMemo(() => curvePoints(SHAPE, ONE, 80), []);
  /** The curve's ceiling, where the sampled line ends. Not where a launch stops. */
  const maxX = pts[pts.length - 1].injRaised;
  const maxY = pts[pts.length - 1].price;
  /** Where a launch actually stops, in the axis's units. */
  const targetX = Number(SHAPE.graduationTarget) / Number(ONE);

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
    /*
     * The state from `stateAtRaised`, which is the function `curvePoints` uses to
     * build the line. It was a second copy of the same derivation here, using plain
     * division where that one rounds the token reserve UP, so the handle's quote
     * disagreed with the line it is drawn under.
     */
    const state = stateAtRaised(SHAPE, raised);
    try {
      const q = quoteBuy(SHAPE, state, ONE);
      /*
       * Position and price from `chartMarker`, the same function the launch page's
       * `CurveChart` places its marker with, against the same axis the line is drawn
       * on. Both of this component's position defects came from doing it by hand:
       *
       *  - The height was computed from its own copy of the curve formula and got it
       *    INVERTED - `1/(vi+r)^2`, which falls as reserves rise, where this curve's
       *    price rises. The handle floated above the line at every point but the ends.
       *  - The x came from `t * maxX` (the CEILING, 1980.95) while every figure under
       *    it was computed at `t * graduationTarget` (1915), so the handle pointed at
       *    one place and read out the price at another: up to 23.4px apart on a 704px
       *    plot, with the price at the drawn position up to 5.16% above the price
       *    displayed, and at the far right the readout said 1,915.00 under a handle
       *    sitting on 1,980.95.
       *
       * `CurveChart` had already found and fixed that second one, and its docblock
       * describes it exactly. It could not propagate because the arithmetic lived
       * inside a component where no test could reach it, which is the note
       * `curve-chart.test.ts` ends on.
       */
      const marker = chartMarker(SHAPE, state, maxX, ONE);
      return {
        raised,
        tokensPerInj: q.tokensOut,
        marker,
        pct: t * 100,
      };
    } catch {
      return null;
    }
  }, [t, maxX]);

  const onMove = useCallback((clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Mapped through the rendered width, not the viewBox: the SVG scales to its
    // container, so using W here would mis-track at every size but one.
    const frac = (clientX - r.left) / r.width;
    /*
     * A fraction of the AXIS, which is then converted into a fraction of the target,
     * because that is what `t` means. Without the conversion the pointer and the
     * handle would disagree by the same 3.44% in the other direction.
     *
     * Dragging past the graduation mark CLAMPS there, and that is the honest
     * behaviour rather than a limitation: nothing can be bought on the curve beyond
     * graduation, so the short tail of line past the mark is a region no launch
     * reaches. The mark on the axis is what makes the handle stopping legible.
     */
    const inner = (frac * W - PAD) / (W - PAD * 2);
    setT(Math.min(1, Math.max(0, (inner * maxX) / (targetX || 1))));
  }, [maxX, targetX]);

  /*
   * Both straight off the marker, so the position and the readout are one
   * measurement and cannot drift apart again.
   */
  const handleX = x(at ? at.marker.injX : 0);
  const handleY = y(at ? at.marker.price : 0);

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

        {/*
            Graduation, marked on the axis because it is where the handle stops and
            because the end of the line is NOT it. Without this the handle appears to
            refuse the last 3.44% of its own track for no reason.
          */}
        <line x1={x(targetX)} y1={PAD} x2={x(targetX)} y2={H - PAD} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="2 4" />
        <text x={x(targetX) - 6} y={PAD + 10} textAnchor="end" className="explorer-axis">
          graduates at {targetX.toFixed(0)}
        </text>

        <line x1={handleX} y1={handleY} x2={handleX} y2={H - PAD} stroke="var(--warn)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <circle cx={handleX} cy={handleY} r="6" fill="var(--warn)" />
        <circle cx={handleX} cy={handleY} r="11" fill="var(--warn)" opacity="0.18" />

        <text x={PAD} y={H - 8} className="explorer-axis">
          0 {NETWORK.quoteSymbol} raised
        </text>
        {/*
            The ceiling, named as the ceiling. This read "(graduation)" over a number
            that is not the graduation target, on the homepage explainer, which is the
            first thing a visitor is taught about how the curve works.
          */}
        <text x={W - PAD} y={H - 8} textAnchor="end" className="explorer-axis">
          {maxX.toFixed(0)} {NETWORK.quoteSymbol} (curve ceiling)
        </text>
      </svg>

      {at && (
        <div className="explorer-read">
          <div>
            <span className="k">Raised</span>
            <span className="v mono">
              {/*
                  `raised` is a QUOTE amount, so it scales by the quote's decimals -
                  the same `NETWORK.quoteDecimals` that `SHAPE` above is built from.
                  It was a literal 18, which agrees with both networks today and is a
                  second copy of the fact the shape already reads. The docblock on
                  `SHAPE` is about exactly this going wrong once already, so a quoted
                  constant here is not a style point. The token figure below stays 18:
                  that one the factory pins.
                */}
              {fmt(at.raised, NETWORK.quoteDecimals, 2)} {NETWORK.quoteSymbol}
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
