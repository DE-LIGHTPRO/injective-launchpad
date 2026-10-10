import { NETWORK, getFactoryAddress } from '@/lib/config';
import { CopyButton } from './CopyButton';

/**
 * What this site is actually pointed at.
 *
 * A launchpad with nothing on it looks identical whether it is connected to a chain
 * or not, and "no launches yet" is what a broken configuration says too. Naming the
 * network and the factory address, with a link to the explorer, is the difference
 * between an empty board and an unverifiable one.
 *
 * It is also the thing a careful visitor checks first, and leaving them to find it in
 * a page source is the posture this product is arguing against.
 */
export function ChainStatus({ height }: { height: number | null }) {
  const factory = getFactoryAddress();
  if (!factory) return null;

  return (
    <section className="chain-status" aria-label="Network">
      <div>
        <span className="k">Network</span>
        <span className="v">Injective {NETWORK.name}</span>
      </div>
      <div>
        <span className="k">Factory</span>
        <span className="v mono">
          <a
            href={`${NETWORK.explorer}/contract/${factory}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {factory.slice(0, 10)}…{factory.slice(-6)}
          </a>
          <CopyButton value={factory} />
        </span>
      </div>
      <div>
        <span className="k">Block</span>
        {/*
            "not read" rather than a dash or a zero. A height of 0 would say the chain
            is at genesis, which is a claim; not reading it is a fact about this page.
          */}
        <span className="v mono">{height === null ? 'not read' : height.toLocaleString('en-US')}</span>
      </div>
    </section>
  );
}
