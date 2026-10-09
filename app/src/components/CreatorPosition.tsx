'use client';

import { useEffect, useState } from 'react';
import {
  readCreatorHolding,
  describeCreatorHolding,
  UNKNOWN_HOLDING,
  type CreatorHolding,
} from '@/lib/creatorHolding';

/**
 * What the creator still holds, which is the number people actually want.
 *
 * Every launchpad shows "holders"; this chain cannot, because `denom_owners` returns
 * 501 for a factory denom and there is no indexer here. But a full holder count was
 * never the question anyone was really asking. "Can the person who made this dump on
 * me" is, and that is ONE address and ONE bank query.
 *
 * Client-side so the figure is current when someone opens the page rather than when
 * the page was last rendered, and because a server render would cache it for everyone.
 */
export function CreatorPosition({
  creator,
  denom,
  totalSupply,
}: {
  creator: string;
  denom: string;
  /** Base units, as a string: a bigint cannot cross the server boundary. */
  totalSupply: string;
}) {
  const [holding, setHolding] = useState<CreatorHolding>(UNKNOWN_HOLDING);
  const [read, setRead] = useState(false);

  useEffect(() => {
    let live = true;
    void readCreatorHolding(creator, denom, BigInt(totalSupply)).then((h) => {
      if (live) {
        setHolding(h);
        setRead(true);
      }
    });
    return () => {
      live = false;
    };
  }, [creator, denom, totalSupply]);

  // Nothing until the read lands. A "could not be read" that flashes before the real
  // figure is worse than a beat of silence: it is a warning that was never true.
  if (!read) return null;

  const { text, tone } = describeCreatorHolding(holding);
  const cls = tone === 'danger' ? 'err-text' : tone === 'warn' ? 'warn-text' : '';

  return (
    <div className="card" style={{ marginTop: 'var(--space-5)' }}>
      <h2>Creator position</h2>
      <p className={`note ${cls}`}>{text}</p>
      {/*
          The limit of the measurement, stated every time rather than once in a FAQ.
          This reads one address. A creator holding nothing here may hold everything
          somewhere else, and a reader who takes this as the whole picture has been
          misled by a true number.
        */}
      <p className="note">
        Read from the launch address only. A creator can hold more in another wallet, so
        this is a floor on their position rather than the whole of it. A full holder
        list is not available on Injective for tokenfactory denoms.
      </p>
    </div>
  );
}
