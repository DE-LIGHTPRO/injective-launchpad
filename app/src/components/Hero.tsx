import Link from 'next/link';

export interface HeroStats {
  launches: number;
  /** Already formatted with its unit, e.g. "188.89 INJ". */
  liquidity: string;
  graduated: number;
  paidToCreators: string;
  /**
   * The quote the two money figures are scoped to, when the board has more than one.
   *
   * `null` when every launch shares a quote, because then they ARE board totals and
   * naming the asset twice is noise.
   *
   * WHY THIS EXISTS. The money figures cover the busiest quote only, deliberately:
   * adding 18-decimal INJ to 6-decimal USDC is wrong by twelve orders of magnitude
   * and there is no oracle here to convert with. But they were labelled "Total
   * liquidity" and "Paid to creators" with no scope, beside a board-wide "Launches"
   * count, so with two quotes live the hero read as a total of everything while
   * silently omitting one asset: 75.71 E2EUSD shown as the total liquidity of a board
   * also holding 4.25 INJ. The arithmetic was right and the label was the lie.
   */
  moneyQuote: string | null;
}

/**
 * The first screen: what this is, why it is different, and the market's pulse.
 *
 * The headline makes the claim the contracts back: liquidity that locks itself at
 * graduation, a supply nobody can add to. Those are this launchpad's reasons to exist
 * against Pons and nearly.trade, so they are the headline rather than a footnote.
 * The stats are the board's own rows, summed, never a second data source.
 *
 * There is no eyebrow pill above the headline. It read "Injective testnet", which is
 * the single least useful thing to put in the largest empty space on the page: the
 * network is already named in the header chip, in `ChainStatus`, and at length on
 * /risks, so the pill disclosed nothing and spent the first line of the first screen
 * announcing the chain instead of what this is for.
 */
export function Hero({ stats }: { stats: HeroStats | null }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
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
            <dt className="k">
              {stats.moneyQuote ? `Liquidity in ${stats.moneyQuote}` : 'Total liquidity'}
            </dt>
            <dd className="v">{stats.liquidity}</dd>
          </div>
          <div className="stat">
            {/* A COUNT, so it spans every pair honestly: ranking or summing amounts
                across quotes is the error, counting launches is not. */}
            <dt className="k">Graduated</dt>
            <dd className="v">{stats.graduated}</dd>
          </div>
          <div className="stat">
            <dt className="k">
              {stats.moneyQuote
                ? `Paid to creators in ${stats.moneyQuote}`
                : 'Paid to creators'}
            </dt>
            <dd className="v">{stats.paidToCreators}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
