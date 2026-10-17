'use client';

import { useEffect, useState } from 'react';
import { assessChainMatch, probeServedChainId, type ChainMatch } from '@/lib/chainMatch';
import { isDevBuild } from '@/lib/config';

/**
 * Says, on every page, when the endpoint being read is not the chain being signed for.
 *
 * See `lib/chainMatch.ts` for what the two variables are and why they can disagree
 * while each is locally correct. This renders nothing at all unless the probe came
 * back and disagreed: a mismatch is a statement about a measurement, so an endpoint
 * that did not answer puts nothing on screen.
 *
 * MOUNTED IN THE LAYOUT, not per page. The condition is global and a page added later
 * would not know to ask. It sits above the content rather than in the header because
 * the claim is about everything below it.
 *
 * The variable names are developer-facing and gated accordingly. The two chain ids are
 * not: they are what was measured, and naming them is the difference between a banner
 * someone can act on and one that says something is wrong.
 */
export function ChainMismatchBanner() {
  const [match, setMatch] = useState<ChainMatch>({ verdict: 'unknown' });

  useEffect(() => {
    let live = true;
    void probeServedChainId().then((served) => {
      if (live) setMatch(assessChainMatch(served));
    });
    return () => {
      live = false;
    };
  }, []);

  if (match.verdict !== 'mismatch') return null;

  return (
    <div className="chain-mismatch" role="alert">
      <strong>Wrong network</strong>
      <span>
        This page is reading <code className="mono">{match.served}</code>, but every
        transaction here is signed for <code className="mono">{match.expected}</code>. The
        launches, balances and prices below are from the wrong chain, and a signature will
        be refused.
        {isDevBuild() && (
          <>
            {' '}
            NEXT_PUBLIC_NETWORK and NEXT_PUBLIC_LCD_URL are set separately and must name the
            same chain.
          </>
        )}
      </span>
    </div>
  );
}
