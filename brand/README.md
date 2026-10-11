# Brand

## The mark

A rounded tile divided by the bonding curve. The two halves are the pool's two
reserves, quote and token, and the line between them is the curve that binds them
(x · y = k). It runs flat, rises and levels off: the curve phase, then the pool locked
at graduation.

| File | Use |
|---|---|
| `mark.svg` | Primary, full colour. Favicon source (`app/src/app/icon.svg`). |
| `mark-mono.svg` | Single colour, inherits `currentColor`. For print, watermarks and one-colour contexts. |
| `mark-180.png` | Opaque square for iOS home screens (`app/src/app/apple-icon.png`). |

In the app, use `components/BrandMark.tsx` and pass a unique `id` per placement.

## Colour

| Token | Hex | Use |
|---|---|---|
| Primary | `#2f6bf0` | Lower half of the mark, primary buttons |
| Tint | `#a9c4ff` | Upper half of the mark |
| Ink | `#0a0b0d` | Background |

## Rules

- Clear space around the mark: at least a quarter of its width.
- Minimum size: 16px. Below 20px, use it without the wordmark.
- Do not recolour the halves, add gradients, shadows or outlines, rotate it, or
  redraw the curve. The curve is the product's own shape.
- Wordmark: Inter Semibold, tracking -0.02em, set beside the mark with a gap of about
  40% of the mark's width.

## Name

**Vetta**, Italian for "summit" (VET-tah): the top of the climb, which is what the mark
draws. Set in Inter Semibold. The name lives in `app/src/lib/brand.ts` (`BRAND_NAME`).
Internal storage keys (`injpad:*`) and the Vercel project name keep the old prefix so
users keep their data and the deploy keeps working.
