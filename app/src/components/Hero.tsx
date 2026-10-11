import Link from 'next/link';
import { NETWORK } from '@/lib/config';

export interface HeroStats {
  launches: number;
  /** Already formatted with its unit, e.g. "188.89 INJ". */
  liquidity: string;
  graduated: number;
  paidToCreators: string;
}

/**
 * The first screen: what this is, why it is different, and the market's pulse.
 *
 * The headline makes the claim the contracts back: liquidity that locks itself at
 * graduation, a supply nobody can add to. Those are this launchpad's reasons to exist
 * against Pons and nearly.trade, so they are the headline rather than a footnote.
 * The stats are the board's own rows, summed, never a second data source.
 */
export function Hero({ stats }: { stats: HeroStats | null }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <span className="hero-eyebrow">Injective {NETWORK.name}</span>
      <h1 id="hero-title">Fair token launches, with liquidity locked at graduation.</h1>
      <p className="sub">
        Fixed supply and one bonding curve for every token. At graduation the liquidity
        moves into a pool no one can withdraw, and no one can mint more.
      </p>
      <div className="hero-cta">
        <Link href="/create" className="go">
          Launch a token
        </Link>
        <a href="#board" className="go ghost">
          Explore launches
        </a>
      </div>
      {stats && (
        <dl className="stats">
          <div className="stat">
            <dt className="k">Launches</dt>
            <dd className="v">{stats.launches}</dd>
          </div>
          <div className="stat">
            <dt className="k">Total liquidity</dt>
            <dd className="v">{stats.liquidity}</dd>
          </div>
          <div className="stat">
            <dt className="k">Graduated</dt>
            <dd className="v">{stats.graduated}</dd>
          </div>
          <div className="stat">
            <dt className="k">Paid to creators</dt>
            <dd className="v">{stats.paidToCreators}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
