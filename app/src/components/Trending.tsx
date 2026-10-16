import Link from 'next/link';
import { TokenLogo } from './TokenLogo';
import { symbolOf } from '@/lib/chain';
import { rowQuoteLabel, type LaunchRow } from '@/lib/launchList';
import type { LaunchEnrichment } from '@/lib/launchActivity';

/**
 * What is actually being traded right now.
 *
 * RANKED BY TRADE COUNT IN THE LAST DAY, not by volume, and that choice is the whole
 * design. Volume is denominated in each launch's quote, so ranking an INJ launch
 * against a USDC one by volume ranks amounts of different assets, and there is no
 * price oracle here to convert with. A trade is a trade in any pair, so a count is
 * the one activity measure that survives crossing a pair boundary.
 *
 * It is also the honest meaning of "trending": a launch with one enormous trade is
 * not trending, a launch with forty small ones is.
 *
 * NO EXTRA REQUESTS. It reads the enrichment the board has already fetched, which is
 * why it lives inside `LaunchList` rather than beside it on the page: a second copy
 * at the page level would double the per-launch request count to render a strip.
 *
 * It renders nothing until something has traded in the window. A "trending" list of
 * launches with no trades is a list of the board in a different order, presented as
 * though it meant something.
 */
export function Trending({
  rows,
  activity,
}: {
  rows: LaunchRow[];
  activity: Record<string, LaunchEnrichment>;
}) {
  const ranked = rows
    .filter((r) => !r.graduated)
    .map((r) => ({ row: r, n: activity[r.curveAddress]?.trades24h ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);

  if (ranked.length === 0) return null;

  return (
    <section className="trending" aria-labelledby="trending-heading">
      <div className="trending-head">
        <h2 id="trending-heading">Trending</h2>
        <p className="note">
          Most trades in about a day. Counted rather than valued, so launches in
          different pairs rank against each other fairly.
        </p>
      </div>
      <ol className="trending-list">
        {ranked.map(({ row: r, n }, i) => (
          <li key={r.id}>
            <Link href={r.path} className="trending-row">
              <span className="trending-rank mono">{i + 1}</span>
              <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={24} />
              <strong>{symbolOf(r.denom)}</strong>
              {/*
                  The pair, because this list deliberately spans them and a reader
                  comparing two rows should see they are different markets.
                */}
              {/* `quoteLabel` is optional on a row, and `rowQuoteLabel` owns what
                  happens without it, so no surface can answer differently. */}
              <span className="chip chip-sm muted">
                {rowQuoteLabel(r)}
              </span>
              <span className="v mono">
                {n} {n === 1 ? 'trade' : 'trades'}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
