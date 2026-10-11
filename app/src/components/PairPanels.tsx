import Link from 'next/link';
import { TokenLogo } from './TokenLogo';
import { symbolOf, denomLabel } from '@/lib/chain';
import { compact } from '@/lib/boardMetrics';
import type { LaunchRow } from '@/lib/launchList';

/**
 * The board's leaders, one panel per pair.
 *
 * nearly.trade runs "NEAR pairs / NEARLY pairs / RHEA pairs" beside its trending
 * list, and the reason is the same one that made this launchpad group its totals: a
 * market cap is denominated in the launch's quote, so a single ranked list spanning
 * pairs is a list of numbers that cannot be compared. Segmenting is the only honest
 * form without a price oracle, and there is none here.
 *
 * ONE PANEL PER PAIR, ranked within it, and the quote is in the heading rather than
 * repeated on every row: everything inside a panel is in that asset, which is the
 * whole point of the panel existing.
 *
 * It renders nothing below two pairs. With one, this is the board again in a smaller
 * font, and the grid underneath already does that job better.
 */
export function PairPanels({ rows }: { rows: LaunchRow[] }) {
  const byPair = new Map<string, LaunchRow[]>();
  for (const r of rows) {
    if (r.graduated) continue;
    const list = byPair.get(r.quoteDenom) ?? [];
    list.push(r);
    byPair.set(r.quoteDenom, list);
  }
  if (byPair.size < 2) return null;

  /*
   * Pairs ordered by how many launches they carry, then by name. Ordering them by
   * total raised would be the obvious alternative and is the same category error the
   * rest of this file exists to avoid: it would sum across pairs to rank pairs.
   */
  const pairs = [...byPair.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  return (
    <section className="pairs" aria-labelledby="pairs-heading">
      <div className="hill-head">
        <h2 id="pairs-heading">By pair</h2>
        <p className="note">
          Every launch is priced in one asset. Figures inside a panel are comparable;
          figures across panels are amounts of different things.
        </p>
      </div>

      <div className="pairs-grid">
        {pairs.map(([denom, list]) => {
          const top = [...list]
            .sort((a, b) => (BigInt(b.marketCap) > BigInt(a.marketCap) ? 1 : -1))
            .slice(0, 3);
          return (
            <div className="pairs-card" key={denom}>
              <div className="pairs-head">
                <strong>{list[0]?.quoteLabel ?? denomLabel(denom)}</strong>
                <span className="note">
                  {list.length} {list.length === 1 ? 'launch' : 'launches'}
                </span>
              </div>
              {top.map((r) => (
                <Link key={r.id} href={r.path} className="pairs-row">
                  <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={24} />
                  <strong>{symbolOf(r.denom)}</strong>
                  {/*
                      No ticker on the row. Everything in this panel is in the asset
                      named above it, and repeating it on every line is noise that
                      also makes the columns ragged.
                    */}
                  <span className="v mono">{compact(BigInt(r.marketCap), r.quoteDecimals)}</span>
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
