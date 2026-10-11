'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { symbolOf } from '@/lib/chain';
import { TokenLogo } from './TokenLogo';
import { StatusChip } from './StatusChip';
import { ageLabel, compact } from '@/lib/boardMetrics';
import { addressName } from '@/lib/addressName';
import { selectLaunches, type ActivityIndex, type LaunchRow, type SortKey } from '@/lib/launchList';
import { enrichAll, tradesLabel, type LaunchEnrichment } from '@/lib/launchActivity';
import { Price } from './Price';
import { PRICE_WAD } from '@/lib/curve';
import { SearchIcon } from './Icons';
import { denomLabel } from '@/lib/chain';

export type { LaunchRow };

/*
 * Price per token from market cap. Every launch has the factory's fixed supply of
 * 1B tokens at 18 decimals, so this is exact rather than an approximation.
 */
const ONE = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * ONE;

/**
 * The launch grid, with search and sort.
 *
 * Every launchpad has both and this one had neither: the index rendered whatever
 * order the factory's registry returned, which is creation order, and offered no
 * way to find a ticker. That is usable at four launches and unusable at four
 * hundred, which is the number a launchpad is built for.
 *
 * BIGINTS DO NOT CROSS THE SERVER BOUNDARY. The page is a server component and
 * these rows carry base-unit amounts, so they arrive as decimal strings and are
 * parsed back here. Passing the bigints directly throws at render time with a
 * serialisation error, and passing them as Numbers would silently lose precision
 * at 18 decimals, which is the quieter of the two failures and the worse one.
 */

const SORTS: Array<{ key: SortKey; label: string; hint: string }> = [
  {
    key: 'marketCap',
    label: 'Market cap',
    hint: 'Spot price times total supply, largest first',
  },
  { key: 'progress', label: 'Closest to graduating', hint: 'Highest share of the target raised' },
  /*
   * The hints name no asset. These sorts can run across pairs, where "largest amount
   * of INJ collected" is wrong for every launch not in INJ, and the figure each card
   * shows already carries its own ticker.
   */
  { key: 'raised', label: 'Most raised', hint: 'Largest amount collected on the curve' },
  { key: 'newest', label: 'Newest', hint: 'Most recently created' },
  /*
   * The two activity sorts. They differ from the four above in one way that matters
   * on screen: their numbers arrive after the board paints, so picking one can settle
   * a moment later. The hint says what is being ranked rather than implying it is
   * instant, and launches whose activity has not been read sort last rather than as
   * zero, because zero would be a claim about a launch nobody has measured.
   */
  { key: 'trades', label: 'Most traded', hint: 'Most buys and sells, lifetime' },
  { key: 'volume', label: 'Most volume', hint: 'Most traded in about 24h' },
];

export function LaunchList({ rows }: { rows: LaunchRow[] }) {
  /*
   * Trade counts, fetched AFTER the board renders and never blocking it.
   *
   * Two count-only tx searches per launch: `pagination.limit=1` returns the `total`
   * and no transaction bodies, so this is cheap, but it is still N requests and the
   * board is the page's reason to exist. It arrives late and the cards reflow by one
   * row rather than the page waiting on it.
   *
   * `null` for a launch whose count failed, which renders as "trades unavailable"
   * rather than "0 trades": zero is a real and common answer on a new board, so a
   * failed read showing zero is indistinguishable from a launch nobody has touched.
   */
  /*
   * Which quote the board is showing, `null` for all of them.
   *
   * Derived from the rows rather than from the factory's allowlist: a quote an
   * operator allowlisted but nobody has launched in is a filter option that returns
   * an empty board, which reads as a broken filter rather than as an unused pair.
   */
  const quotesPresent = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.quoteDenom, (seen.get(r.quoteDenom) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const [quote, setQuote] = useState<string | null>(null);

  const [activity, setActivity] = useState<Record<string, LaunchEnrichment>>({});

  /*
   * The shape the selector sorts on, derived rather than stored.
   *
   * Narrowed to the two fields a sort reads, so the selector cannot accidentally
   * start depending on the chart series or the trader count, which are presentation
   * and would make a sort order change for a reason nobody could see.
   */
  const activityIndex = useMemo<ActivityIndex>(() => {
    const out: ActivityIndex = {};
    for (const [curve, e] of Object.entries(activity)) {
      out[curve] = { trades: e.activity?.trades ?? null, volume24h: e.volume24h };
    }
    return out;
  }, [activity]);
  const curveKey = rows.map((r) => r.curveAddress).join(',');
  useEffect(() => {
    const curves = curveKey ? curveKey.split(',') : [];
    if (curves.length === 0) return;
    let live = true;
    void enrichAll(curves).then((a) => {
      if (live) setActivity(a);
    });
    return () => {
      live = false;
    };
  }, [curveKey]);
  /*
   * One clock for the whole board, taken on mount rather than per card.
   *
   * `Date.now()` during render differs between the server pass and the first client
   * pass, which React reports as a hydration mismatch and which blanks the list it
   * happens in. Seeded at zero so both passes agree, then set in an effect: ages are
   * absent for one frame, which is better than a list that fails to hydrate.
   */
  const [nowSeconds, setNowSeconds] = useState(0);
  useEffect(() => {
    setNowSeconds(Math.floor(Date.now() / 1000));
    const id = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const [q, setQ] = useState('');
    /*
   * Market cap first, which is what a launchpad board defaults to everywhere. The
   * previous default was "closest to graduating", which answers a different question:
   * it surfaces launches that are nearly finished rather than launches people are
   * actually in.
   */
  const [sort, setSort] = useState<SortKey>('marketCap');
  const [hideGraduated, setHideGraduated] = useState(false);

  // One implementation, in `lib/launchList.ts`, where the tests can reach it.
  const shown = useMemo(
    () => selectLaunches(rows, { q, sort, hideGraduated, quote }, activityIndex),
    // `activityIndex` IS a dependency. Leaving it out compiles and looks right, and
    // the board would simply never re-sort when the numbers land: picking "Most
    // traded" would rank by data that arrived a second later and never be applied.
    [rows, q, sort, hideGraduated, quote, activityIndex],
  );

  const active = SORTS.find((s) => s.key === sort);

  return (
    <>
      <div className="board-bar">
        <label className="search">
          <span className="sr-only">Search launches</span>
          <SearchIcon />
          <input
            id="launch-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search ticker, denom or creator"
            autoComplete="off"
            aria-describedby="launch-count"
          />
        </label>
        {quotesPresent.length > 1 && (
          <label className="select">
            <span className="sr-only">Paired with</span>
            <select value={quote ?? ''} onChange={(e) => setQuote(e.target.value || null)}>
              <option value="">All pairs</option>
              {quotesPresent.map(([denom, n]) => (
                <option key={denom} value={denom}>
                  {rows.find((r) => r.quoteDenom === denom)?.quoteLabel ?? denomLabel(denom)} ({n})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="select">
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title={active?.hint}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            id="hide-graduated"
            type="checkbox"
            checked={hideGraduated}
            onChange={(e) => setHideGraduated(e.target.checked)}
          />
          <span>Hide graduated</span>
        </label>
        <span className="board-count" id="launch-count" aria-live="polite">
          {shown.length === rows.length ? `${rows.length} launches` : `${shown.length} of ${rows.length}`}
        </span>
      </div>

      {shown.length === 0 && (
        <div className="empty">
          <p>No launches match {q.trim() ? <strong>{q.trim()}</strong> : 'these filters'}.</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="table-wrap">
          {/*
              A table, because this is tabular data a trader scans down a column of.
              The whole row is clickable through a stretched link on the token cell,
              so the markup stays a real table for screen readers and the only
              interactive element per row is that one link.
            */}
          <table className="board">
            <thead>
              <tr>
                <th scope="col" className="c-rank">#</th>
                <th scope="col">Token</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Market cap</th>
                <th scope="col" className="num hide-md">Vol 24h</th>
                <th scope="col" className="num hide-md">Trades</th>
                <th scope="col" className="c-progress hide-sm">Bonding</th>
                <th scope="col" className="num hide-sm">Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const unit = r.quoteLabel ?? denomLabel(r.quoteDenom);
                const e = activity[r.curveAddress];
                const pct = Math.min(100, r.progress * 100);
                return (
                  <tr key={r.id}>
                    <td className="c-rank">{i + 1}</td>
                    <td>
                      <div className="tok">
                        <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={32} />
                        <div className="tok-text">
                          <Link href={`/launch/${r.id}`} className="row-link">
                            {symbolOf(r.denom)}
                          </Link>
                          <span className="tok-sub">
                            {addressName(r.creator)}
                            {r.graduated ? (
                              <span className="tag tag-pool">Pool</span>
                            ) : (
                              <StatusChip graduated={r.graduated} rules={r.rules} />
                            )}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="num">
                      {/* Wad precision: a 6-decimal quote's price is below one base unit. */}
                      <Price raw={(BigInt(r.marketCap) * ONE * PRICE_WAD) / TOTAL_SUPPLY} decimals={r.quoteDecimals + 18} />
                    </td>
                    <td className="num strong">
                      {compact(BigInt(r.marketCap), r.quoteDecimals)} <span className="unit">{unit}</span>
                    </td>
                    <td className="num hide-md">
                      {e === undefined || e.volume24h === null ? (
                        <span className="dim">·</span>
                      ) : (
                        <>
                          {compact(e.volume24h, r.quoteDecimals)} <span className="unit">{unit}</span>
                        </>
                      )}
                    </td>
                    <td className="num hide-md">
                      {e === undefined ? <span className="dim">·</span> : tradesLabel(e.activity).replace(' trades', '')}
                    </td>
                    <td className="c-progress hide-sm">
                      <div className="prog" aria-label={`${pct.toFixed(1)}% bonded`}>
                        <div className="prog-track">
                          <i style={{ width: `${pct.toFixed(1)}%` }} />
                        </div>
                        <span>{pct.toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="num hide-sm dim">{ageLabel(r.openedAt, nowSeconds) ?? '·'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
