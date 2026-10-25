import Link from 'next/link';
import Image from 'next/image';

export interface HeroStats {
  launches: number;
  /**
   * How many of those are still on their curve.
   *
   * A board-wide COUNT like `launches` and `graduated`, not a money figure, so it
   * spans every pair without the cross-quote problem the amounts below have.
   */
  live: number;
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
      {/*
          THE EMPTY HALF, FILLED. 60% of the first screen was black, and the one visual
          that explains this product is a rising curve - so the art is a curve rather
          than a generic abstract.

          `aria-hidden` and empty alt: it is decoration. The sentence beside it already
          says what it says, and announcing "glowing blue curve" to a screen reader adds
          nothing a listener can act on.

          `priority` because it is above the fold on every visit to the busiest page, so
          lazy-loading it would only guarantee it arrives late. `next/image` serves it as
          WebP at the size actually needed; the source PNG is 1.1MB and must never reach
          a phone as one.
        */}
      <Image
        src="/hero-curve.png"
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="(max-width: 900px) 100vw, 60vw"
        className="hero-art"
      />
      {/*
          THE CLAIM IS THE ACCENT. The headline carried no colour at all, so the one
          sentence stating why this launchpad exists read with exactly the emphasis of
          the paragraph under it. "Locked at graduation" is the promise the contracts
          back and the reason to choose this over a pad that can pull liquidity, so it
          is the half that is coloured.

          One `<h1>` with a `<span>` inside, not two elements: a screen reader reads it
          as one sentence either way, and splitting it into separate headings would
          invent a structure the page does not have.
        */}
      <h1 id="hero-title">
        Fair token launches, with liquidity{' '}
        <span className="hero-accent">locked at graduation</span>.
      </h1>
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
        /*
            THREE TIERS, AND THE THIRD FIXED A DEFECT RATHER THAN DECORATING.
            Label over value is two lines of equal weight, which reads as a table. The
            caption underneath carries the meaning the label was straining to hold.

            It also removes a duplicated unit. Two of these read "Liquidity in INJ"
            above "1.10 INJ" and "Paid to creators in INJ" above "0.0138 INJ" - the
            asset named twice in one cell, because the label was doing two jobs at
            once. The value already says which asset it is; the label only ever needed
            to say WHAT the number is.

            The scope moves to the caption rather than disappearing, which is the half
            that matters. These two money figures cover the busiest quote only, since
            summing 18-decimal INJ with 6-decimal USDC is wrong by twelve orders of
            magnitude and there is no oracle here. `moneyQuote` is non-null exactly
            when that scope is narrower than the board, and the caption then says so in
            words that have room to be clear.
          */
        <dl className="stats">
          <div className="stat">
            <dt className="k">Launches</dt>
            <dd className="v">{stats.launches}</dd>
            <dd className="stat-note">
              {stats.live === stats.launches ? 'all live' : `${stats.live} live`}
            </dd>
          </div>
          <div className="stat">
            <dt className="k">Liquidity</dt>
            <dd className="v">{stats.liquidity}</dd>
            <dd className="stat-note">
              {stats.moneyQuote ? `${stats.moneyQuote} pairs only` : 'in curve reserves'}
            </dd>
          </div>
          <div className="stat">
            {/* A COUNT, so it spans every pair honestly: ranking or summing amounts
                across quotes is the error, counting launches is not. */}
            <dt className="k">Graduated</dt>
            <dd className="v">{stats.graduated}</dd>
            <dd className="stat-note">liquidity locked</dd>
          </div>
          <div className="stat">
            <dt className="k">Paid to creators</dt>
            <dd className="v">{stats.paidToCreators}</dd>
            <dd className="stat-note">
              {stats.moneyQuote ? `${stats.moneyQuote} pairs only` : 'fees claimed so far'}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
