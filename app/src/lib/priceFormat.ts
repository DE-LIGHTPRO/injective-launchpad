/**
 * Prices the way a trader reads them.
 *
 * Launch prices are tiny: 0.0000002942 INJ per token. Printed in full, the number is
 * all zeros and the digits that matter are at the end, where the eye gets lost
 * counting. DEX screeners settled on subscript zeros, 0.0₆2942, which keeps the
 * significant digits up front and the magnitude one glance away. This returns the
 * parts so a component can render the subscript as markup; `priceText` gives the
 * same thing as plain text for titles and share cards.
 */

export interface PriceParts {
  /** Everything before the run of zeros, e.g. "0.0". Empty for prices >= 0.001. */
  lead: string;
  /** How many zeros were folded, or 0 when none were. */
  zeros: number;
  /** The significant digits, or the whole formatted number when nothing was folded. */
  digits: string;
}

/** Fold when at least this many zeros follow the decimal point. */
const FOLD_AT = 4;

export function priceParts(raw: bigint, decimals: number, significant = 4): PriceParts {
  if (raw <= 0n) return { lead: '', zeros: 0, digits: '0' };
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  if (whole > 0n) {
    // At or above 1: ordinary grouping, a few decimals.
    const frac = (raw % unit).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return { lead: '', zeros: 0, digits: `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}` };
  }
  const frac = (raw % unit).toString().padStart(decimals, '0');
  const leadingZeros = frac.length - frac.replace(/^0+/, '').length;
  const sig = frac.slice(leadingZeros, leadingZeros + significant).replace(/0+$/, '') || '0';
  if (leadingZeros < FOLD_AT) {
    return { lead: '', zeros: 0, digits: `0.${'0'.repeat(leadingZeros)}${sig}` };
  }
  // The subscript counts every zero after the point, the convention screeners use:
  // 0.0₆2942 is 0.0000002942.
  return { lead: '0.0', zeros: leadingZeros, digits: sig };
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

export function priceText(raw: bigint, decimals: number, significant = 4): string {
  const p = priceParts(raw, decimals, significant);
  if (p.zeros === 0) return p.digits;
  const sub = String(p.zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `${p.lead}${sub}${p.digits}`;
}

/**
 * The same price written out in full, with every zero present.
 *
 * FOR ANYTHING THAT IS READ RATHER THAN LOOKED AT. The subscript is a visual
 * shorthand and both of its forms lose the magnitude when they are not seen: the
 * markup hides the count from the accessibility tree, and `priceText`'s `₆` is a
 * character most screen readers skip. ORBIT's spot price was announced as "0.063 INJ"
 * for a price of 0.00000063 INJ - a hundred thousand times over, on a figure somebody
 * would decide a trade on.
 *
 * Measured, not assumed: the rendered markup was `0.0<sub aria-hidden>6</sub>63`, so
 * the span's accessible name is its text content with the count removed. `title` does
 * not rescue it, because a `<span>` holding text takes its name from that text.
 */
export function priceDecimalText(raw: bigint, decimals: number, significant = 4): string {
  const p = priceParts(raw, decimals, significant);
  if (p.zeros === 0) return p.digits;
  // `zeros` counts every zero after the point, which is why `lead` is dropped here
  // rather than prefixed: it already contains the first of them.
  return `0.${'0'.repeat(p.zeros)}${p.digits}`;
}

/** A stable hue for a ticker, so the same token always gets the same colour. */
export function tickerHue(symbol: string): number {
  let h = 0;
  for (const ch of symbol.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
