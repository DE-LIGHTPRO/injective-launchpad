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
      <span className="hero-eyebrow">
        <i aria-hidden="true" />
        Live on Injective {NETWORK.name}
      </span>
      <h1 id="hero-title">
        Fair launches on Injective. <span className="grad">Liquidity that locks itself.</span>
      </h1>
      <p className="sub">
        Every token gets the same fixed supply and the same curve. When it graduates, the
        liquidity moves into a pool nobody can withdraw, and nobody can mint another token.
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
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="v">{stats.launches}</span>
            <span className="k">Launches</span>
          </div>
          <div className="hero-stat">
            <span className="v">{stats.liquidity}</span>
            <span className="k">Liquidity on inj·pad</span>
          </div>
          <div className="hero-stat">
            <span className="v">{stats.graduated}</span>
            <span className="k">Graduated, locked</span>
          </div>
          <div className="hero-stat">
            <span className="v">{stats.paidToCreators}</span>
            <span className="k">Paid to creators</span>
          </div>
        </div>
      )}
    </section>
  );
}
