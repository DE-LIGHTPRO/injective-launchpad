import { priceParts, priceText } from '@/lib/priceFormat';

/** A price with subscript zeros, readable by screen readers as the full figure. */
export function Price({ raw, decimals, unit }: { raw: bigint; decimals: number; unit?: string }) {
  const p = priceParts(raw, decimals);
  const label = `${priceText(raw, decimals)}${unit ? ` ${unit}` : ''}`;
  return (
    <span title={label}>
      {p.zeros > 0 ? (
        <>
          {p.lead}
          <sub className="px-zeros" aria-hidden="true">
            {p.zeros}
          </sub>
          {p.digits}
        </>
      ) : (
        p.digits
      )}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}
