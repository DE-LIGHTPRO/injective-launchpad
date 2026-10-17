'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { symbolOf } from '@/lib/chain';
import { TokenLogo } from './TokenLogo';
import { StatusChip } from './StatusChip';
import { ageLabel, compact } from '@/lib/boardMetrics';
import { addressName } from '@/lib/addressName';
import {
  anyActivityUnread,
  rowQuoteLabel,
  selectLaunches,
  type ActivityIndex,
  type LaunchRow,
  type SortKey,
  type LaunchStatus,
} from '@/lib/launchList';
import { enrichAll, tradesLabel, type LaunchEnrichment } from '@/lib/launchActivity';
import { Price } from './Price';
import { PRICE_WAD } from '@/lib/curve';
import { SearchIcon } from './Icons';
import { Trending } from './Trending';
import { FIXED_TOTAL_SUPPLY } from '@/lib/launchLimits';

export type { LaunchRow };

/*
 * Price per token from market cap. Every launch has the factory's fixed supply of
 * 1B tokens at 18 decimals, so this is exact rather than an approximation.
 *
 * The supply comes from `FIXED_TOTAL_SUPPLY`, which mirrors the contract. It was a
 * local `1_000_000_000n * ONE` here and another in `Portfolio`, so three copies of
 * the number that divides every price on the board and every valuation in the
 * portfolio. A change to the factory's supply would have left both screens pricing
 * against the old one with nothing looking unusual.
 */
const ONE = 10n ** 18n;

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
   * Two count-only tx searches per launch: `limit=1` returns the `total` and one
   * transaction body rather than the default hundred, so this is cheap, but it is
   * still N requests and the board is the page's reason to exist. It arrives late and
   * the cards reflow by one row rather than the page waiting on it.
   *
   * `pagination.limit` is the wrong parameter for that endpoint and was what this did
   * for every count the board has ever taken. See `launchActivity.ts`.
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
  const [status, setStatus] = useState<LaunchStatus>('all');

  // One implementation, in `lib/launchList.ts`, where the tests can reach it.
  const shown = useMemo(
    () => selectLaunches(rows, { q, sort, hideGraduated: false, status, quote }, activityIndex),
    // `activityIndex` IS a dependency. Leaving it out compiles and looks right, and
    // the board would simply never re-sort when the numbers land: picking "Most
    // traded" would rank by data that arrived a second later and never be applied.
    [rows, q, sort, status, quote, activityIndex],
  );

  /*
   * Whether any shown launch's activity could not be read, so the board can say why.
   *
   * THE FIGURES WERE ALREADY HONEST AND THE SCREEN STILL WAS NOT. `Vol 24h` renders a
   * null as a dim dot, which is correct, and on the live testnet board that was every
   * row at once: the LCD answers the trade search with HTTP 500 `height N is not
   * available, lowest height is M` for any curve older than the answering node's
   * retention, measured on all four curves on 16 Oct 2026. A whole column of dots with
   * nothing explaining it is the board's version of the defect `/analytics` names on
   * itself, where the fix is the same sentence: stated rather than omitted, so a quiet
   * launchpad and a page that could not measure are distinguishable.
   *
   * Gated on enrichment having LANDED for the row, because `undefined` is also a dot
   * and every first paint is full of them. Without that the note would flash on a
   * board whose numbers are about to arrive, which would be a worse claim than the
   * silence it replaces. That gate lives in `anyActivityUnread`, in `lib/launchList.ts`
   * with the selector, where a test can drive it.
   */
  const anyUnread = useMemo(() => anyActivityUnread(shown, activityIndex), [shown, activityIndex]);

  /*
   * Stage tabs, like pump.fun's "newly created / about to graduate / graduated". Counts
   * are of the rows in each stage BEFORE the search box narrows them, so an empty tab
   * reads as "none at this stage" rather than "no match", and a count never jumps when
   * you type. Computed over all rows, not `shown`, for the same reason.
   */
  const stageCounts = useMemo(() => {
    let live = 0;
    let soon = 0;
    let graduated = 0;
    for (const r of rows) {
      if (r.graduated) graduated += 1;
      else {
        live += 1;
        if (r.progress >= 0.8) soon += 1;
      }
    }
    return { all: rows.length, live, soon, graduated };
  }, [rows]);

  const STAGES: Array<{ key: LaunchStatus; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'live', label: 'Live' },
    { key: 'soon', label: 'About to graduate' },
    { key: 'graduated', label: 'Graduated' },
  ];

  const active = SORTS.find((s) => s.key === sort);

  return (
    <>
      {/*
          Trending sits inside this component, not beside it on the page, because it
          reads the enrichment already fetched here. A copy at the page level would
          double the per-launch request count to render a strip.
        */}
      <Trending rows={rows} activity={activity} />

      <div className="board-tabs" role="tablist" aria-label="Launch stage">
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={status === s.key}
            className={`board-tab${status === s.key ? ' is-active' : ''}`}
            onClick={() => setStatus(s.key)}
          >
            {s.label}
            <span className="board-tab-count">{stageCounts[s.key]}</span>
          </button>
        ))}
      </div>
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
                  {rowQuoteLabel(rows.find((r) => r.quoteDenom === denom) ?? { quoteDenom: denom })} ({n})
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
        <span className="board-count" id="launch-count" aria-live="polite">
          {/*
            * Pluralised, because this is the one count in the app that was not. Every
            * other one already is (analytics, ClaimFees, Trending, PriceChart), so
            * "1 launches" read as a bug in the board rather than as a style choice,
            * and it is exactly what a one-entry watchlist shows.
            */}
          {shown.length === rows.length
            ? `${rows.length} ${rows.length === 1 ? 'launch' : 'launches'}`
            : `${shown.length} of ${rows.length}`}
        </span>
      </div>

      {shown.length === 0 && (
        <div className="empty">
          <p>No launches match {q.trim() ? <strong>{q.trim()}</strong> : 'these filters'}.</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Launch board">
          {/*
              A table, because this is tabular data a trader scans down a column of.
              The whole row is clickable through a stretched link on the token cell,
              so the markup stays a real table for screen readers and the only
              interactive element per row is that one link.

              `tabIndex={0}` and `role="region"`: this div scrolls horizontally, and a
              scroll container that is not focusable fails WCAG 2.1.1 - the columns past
              its right edge are reachable by gesture and by nothing else. It was
              `tabIndex: -1` with no role and no label, measured on a 375px viewport
              with 106px hidden. The label is what makes the extra tab stop
              intelligible rather than a mystery stop before the first row.
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
                const unit = rowQuoteLabel(r);
                const e = activity[r.curveAddress];
                const pct = Math.min(100, r.progress * 100);
                return (
                  <tr key={r.id}>
                    <td className="c-rank">{i + 1}</td>
                    <td>
                      <div className="tok">
                        <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={32} />
                        <div className="tok-text">
                          <Link href={r.path} className="row-link">
                            {symbolOf(r.denom)}
                          </Link>
                          <span className="tok-sub">
                            {/* Its own element so it can ellipsise on a phone without
                                clipping the chip beside it. See `.tok-creator`. */}
                            <span className="tok-creator">{addressName(r.creator)}</span>
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
                      <Price raw={(BigInt(r.marketCap) * ONE * PRICE_WAD) / FIXED_TOTAL_SUPPLY} decimals={r.quoteDecimals + 18} />
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
                      {/*
                        The dot is the same unknown the volume cell beside it renders, and
                        the note under the table promises exactly that. Before this, an
                        unread count rendered the sentence "trades unavailable" inside a
                        numeric column while its neighbour rendered `·` for the same
                        state, so the note was untrue for every pruned launch.
                      */}
                      {tradesLabel(e?.activity) ?? <span className="dim">·</span>}
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

      {anyUnread && (
        <p className="note">
          Volume and trades are read from transaction history, which a public node keeps
          only for a recent window. A dot in those columns means the figure could not be
          read, never that it is zero.
        </p>
      )}
    </>
  );
}
