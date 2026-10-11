'use client';

import { useState } from 'react';
import { imageSrc } from '@/lib/tokenProfile';
import { tickerHue } from '@/lib/priceFormat';
import type { TokenProfile } from '@/lib/tokenProfile';

/**
 * A token's own image, or its ticker when there is nothing safe to show.
 *
 * Three things have to be true at once and each is a separate failure if it is not:
 *
 *   1. The src is never the creator's raw string. `imageSrc` runs the scheme allowlist
 *      and routes `ipfs://` through a gateway, because a browser does not resolve
 *      `ipfs:` natively and `<img src="ipfs://…">` renders a blank box forever.
 *   2. A broken image falls back to the ticker rather than to a blank square. Remote
 *      artwork a stranger controls will go away, and a token with no visible identity
 *      in a list is worse than one with a plain monogram.
 *   3. `alt=""` and not the ticker. The ticker is already next to this in text, so a
 *      duplicate alt makes a screen reader read it twice; the image is decoration here.
 *
 * `referrerPolicy="no-referrer"` because otherwise every token page tells whoever hosts
 * that image which launch a visitor is looking at.
 */
export function TokenLogo({
  profile,
  symbol,
  size = 40,
}: {
  profile: TokenProfile | null | undefined;
  symbol: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const src = imageSrc(profile?.image);

  if (src === null || broken) {
    return (
      <span
        className="token-logo token-logo-fallback"
        style={
          {
            width: size,
            height: size,
            fontSize: Math.round(size * 0.36),
            // A generated identity: the same ticker always gets the same gradient.
            '--h': tickerHue(symbol),
          } as React.CSSProperties
        }
        aria-hidden="true"
      >
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className="token-logo"
      style={{ width: size, height: size }}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
