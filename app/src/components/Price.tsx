import { priceDecimalText, priceParts } from '@/lib/priceFormat';

/**
 * A price with subscript zeros, and the same price written out for anything reading it.
 *
 * THIS DOCBLOCK USED TO CLAIM THE SCREEN READER GOT THE FULL FIGURE AND IT DID NOT.
 * The count of folded zeros was the only thing carrying the magnitude and it was
 * `aria-hidden`, with nothing in its place, so the accessible name of ORBIT's spot
 * price was "0.063 INJ" for a price of 0.00000063 INJ. `title` was not a fix: a
 * `<span>` holding text takes its accessible name from that text, so the attribute was
 * a mouse tooltip and nothing more. It also held the `₆` form, which is the same
 * shorthand in a character rather than in markup.
 *
 * So the figure is rendered twice: once expanded for the accessibility tree, once
 * folded and hidden from it. The visual half must stay `aria-hidden`, or a reader hears
 * both and the second one is the wrong number.
 */
export function Price({ raw, decimals, unit }: { raw: bigint; decimals: number; unit?: string }) {
  const p = priceParts(raw, decimals);
  const suffix = unit ? ` ${unit}` : '';
  const spoken = `${priceDecimalText(raw, decimals)}${suffix}`;
  // The tooltip is the written-out figure too. A hover asking "what is this really"
  // wants the zeros, not the shorthand it is already looking at.
  return (
    <span title={spoken}>
      {p.zeros > 0 ? (
        <>
          <span className="sr-only">{spoken}</span>
          <span aria-hidden="true">
            {p.lead}
            <sub className="px-zeros">{p.zeros}</sub>
            {p.digits}
            {suffix}
          </span>
        </>
      ) : (
        <>
          {p.digits}
          {suffix}
        </>
      )}
    </span>
  );
}
