'use client';

import { useState } from 'react';

/**
 * Share a launch: copy its link, or post it.
 *
 * Launches spread by being shared; a page with no way to share it makes every
 * creator rebuild the link by hand. The X intent is a plain link (no SDK, no script
 * from x.com on our page), and the text says only what the chain says.
 */
export function ShareRow({ symbol, path }: { symbol: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const url = () => (typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString());
  const text = `$${symbol} on inj·pad: fixed supply, liquidity that locks itself at graduation.`;

  return (
    <div className="share-row">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch {
            /* clipboard blocked: the address bar still has it */
          }
        }}
      >
        {copied ? 'Link copied' : 'Copy link'}
      </button>
      <a
        href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url())}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Share on X
      </a>
    </div>
  );
}
