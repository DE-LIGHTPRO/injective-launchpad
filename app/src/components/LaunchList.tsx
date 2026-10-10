'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { symbolOf, short } from '@/lib/chain';
import { TokenLogo } from './TokenLogo';
import { StatusChip } from './StatusChip';
import { CurveGlyph } from './CurveGlyph';
import { ageLabel, feeLabel, compact } from '@/lib/boardMetrics';
import { addressName } from '@/lib/addressName';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { selectLaunches, type ActivityIndex, type LaunchRow, type SortKey } from '@/lib/launchList';
import { enrichAll, tradesLabel, type LaunchEnrichment } from '@/lib/launchActivity';
import { Sparkline } from './Sparkline';
import { denomLabel } from '@/lib/chain';

export type { LaunchRow };

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
  { key: 'raised', label: 'Most raised', hint: `Largest amount of ${NETWORK.quoteSymbol} collected` },
  { key: 'newest', label: 'Newest', hint: 'Most recently created' },
  /*
   * The two activity sorts. They differ from the four above in one way that matters
   * on screen: their numbers arrive after the board paints, so picking one can settle
   * a moment later. The hint says what is being ranked rather than implying it is
   * instant, and launches whose activity has not been read sort last rather than as
   * zero, because zero would be a claim about a launch nobody has measured.
   */
  { key: 'trades', label: 'Most traded', hint: 'Most buys and sells, lifetime' },
  { key: 'volume', label: 'Most volume', hint: `Most ${NETWORK.quoteSymbol} traded in about 24h` },
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
      <div className="list-controls">
        <label className="search">
          <span className="sr-only">Search launches</span>
          <input
            id="launch-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Ticker, denom or creator`}
            autoComplete="off"
            aria-describedby="launch-count"
          />
        </label>

        <div className="segmented" role="group" aria-label="Sort launches">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={sort === s.key}
              title={s.hint}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label className="toggle">
          <input
            id="hide-graduated"
            type="checkbox"
            checked={hideGraduated}
            onChange={(e) => setHideGraduated(e.target.checked)}
          />
          <span>Hide graduated</span>
        </label>
      </div>

      {/*
          PAIRED WITH, and it renders only when more than one quote is actually in
          use. With a single quote it is a filter whose every option shows the same
          board, which is a control that does nothing.

          It filters rather than converts, because converting would need a price for
          each quote and there is no oracle here. Within one pair every figure on the
          board is comparable; across pairs they are base units of different assets,
          which is why the totals above group by quote rather than summing.
        */}
      {quotesPresent.length > 1 && (
        <div className="segmented pair-filter" role="group" aria-label="Paired with">
          <button type="button" aria-pressed={quote === null} onClick={() => setQuote(null)}>
            All pairs
          </button>
          {quotesPresent.map(([denom, n]) => (
            <button
              key={denom}
              type="button"
              aria-pressed={quote === denom}
              onClick={() => setQuote(denom)}
            >
              {denomLabel(denom)} <span className="hint">{n}</span>
            </button>
          ))}
        </div>
      )}

      {/*
          The count is stated rather than left for the reader to infer from an
          empty grid. "Showing 3 of 40" is the difference between a filter that
          worked and a page that broke.
        */}
      <p className="note" id="launch-count" aria-live="polite">
        {shown.length === rows.length
          ? `${rows.length} launch${rows.length === 1 ? '' : 'es'}, ${active?.label.toLowerCase()} first`
          : `${shown.length} of ${rows.length}, ${active?.label.toLowerCase()} first`}
      </p>

      {shown.length === 0 && (
        <div className="empty" style={{ marginTop: 'var(--space-4)' }}>
          <p>
            Nothing matches {q.trim() ? <strong>{q.trim()}</strong> : 'these filters'}.
          </p>
          <p className="note">
            Search covers the ticker, the full denom and the creator address.
          </p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid" style={{ marginTop: 'var(--space-4)' }}>
          {shown.map((r) => (
            <Link key={r.id} href={`/launch/${r.id}`} className="card">
              <div className="card-head">
                <div className="sym-row">
                  <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={40} />
                  {/*
                      No denom line here, and removing it was the second attempt.
                      Shortening it was the first, and the CSS ellipsis then cut the
                      shortened string again and took the subdenom with it, which is
                      the exact failure the shortening was written to avoid.
                      Looking at the card properly: the heading IS the subdenom and
                      there is a Creator row below, so the denom repeated both of its
                      own parts and nothing else. The full value is one click away on
                      the detail page, and search still covers it.
                    */}
                  <div style={{ minWidth: 0 }}>
                    <div className="sym" title={r.denom}>
                      {symbolOf(r.denom)}
                    </div>
                    {/*
                        Who made it and when, the line every mature launchpad puts
                        here. The age comes from the curve's `opened_at`, which the
                        contract already stores for the opening-fee decay, so it costs
                        no extra query and cannot drift from what the fee uses.
                      */}
                    <div className="card-by">
                      {/*
                          A readable name, with the address still in the title. The
                          name is derived and nobody has claimed it, so it is a label
                          rather than a handle: a visitor can use it to notice the
                          same creator twice on one board, which is a judgement the
                          data supports, and cannot use it to identify anyone, which
                          is one it does not.
                        */}
                      by <span title={r.creator}>{addressName(r.creator)}</span>
                      {ageLabel(r.openedAt, nowSeconds) && (
                        <> · {ageLabel(r.openedAt, nowSeconds)}</>
                      )}
                    </div>
                  </div>
                </div>
                {/*
                    Status comes from `launchStatus`, never from `graduated` alone.
                    This chip read "live" on a launch whose start time had not arrived,
                    which is the most confident possible label on the one state where
                    the contract refuses every buy.
                  */}
                <div className="card-badges">
                  <span className="chip chip-sm">{feeLabel(BigInt(r.curve.feeBps))}</span>
                  <StatusChip graduated={r.graduated} rules={r.rules} />
                </div>
              </div>

              {/*
                  The curve, not a progress bar. Two launches at 40% show the same bar
                  and completely different curves, and the shape is what tells a buyer
                  whether the next purchase costs sharply more. The bar stays beneath
                  it, thinner: progress is still worth a glance, it just is not the
                  thing that distinguishes one launch from another.
                */}
              {/*
                  Market cap as the headline, which is how a launchpad board is read.
                  Quoted in INJ rather than USD: a USD figure needs a price for INJ,
                  which is a separate measurement with its own provenance, and an
                  unlabelled dollar sign over an unsourced conversion is the kind of
                  number this project keeps finding and removing.
                */}
              <div className="card-mc">
                <span className="mc-label">MC</span>
                <span className="mc-value mono">
                  {compact(BigInt(r.marketCap), r.quoteDecimals)} {denomLabel(r.quoteDenom)}
                </span>
              </div>

              <div className="card-curve">
                <CurveGlyph
                  config={{
                    virtualInj: BigInt(r.curve.virtualInj),
                    virtualTokens: BigInt(r.curve.virtualTokens),
                    curveSupply: BigInt(r.curve.curveSupply),
                    graduationTarget: BigInt(r.curve.graduationTarget),
                    feeBps: BigInt(r.curve.feeBps),
                  }}
                  state={{
                    injCollected: BigInt(r.raised),
                    tokensSold: BigInt(r.tokensSold),
                    graduated: r.graduated,
                  }}
                  height={48}
                />
              </div>
              <div className="bar bar-thin">
                <i style={{ width: `${Math.min(100, r.progress * 100).toFixed(1)}%` }} />
              </div>

              <div style={{ marginTop: 'var(--space-4)' }}>
                <div className="metric-row">
                  <span className="k">Raised</span>
                  <span className="v mono">
                    {fmt(BigInt(r.raised), r.quoteDecimals, 2)} /{' '}
                    {fmt(BigInt(r.target), r.quoteDecimals, 0)}{' '}
                    {denomLabel(r.quoteDenom)}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Progress</span>
                  <span className="v mono">{(r.progress * 100).toFixed(1)}%</span>
                </div>
                <div className="metric-row">
                  <span className="k">Creator</span>
                  <span className="v mono">{short(r.creator)}</span>
                </div>
                {/*
                    Rendered only once the count has landed. A placeholder row that
                    later becomes a number makes the whole card twitch; an absent row
                    that appears does it once, in one place.
                  */}
                {r.curveAddress in activity && (
                  <>
                    <div className="metric-row">
                      <span className="k">Activity</span>
                      <span className="v mono">
                        {tradesLabel(activity[r.curveAddress].activity)}
                      </span>
                    </div>
                    <div className="metric-row">
                      <span className="k">Volume, about 24h</span>
                      <span className="v mono">
                        {(() => {
                          const e = activity[r.curveAddress];
                          /*
                            * `null` is "the window is unknown", which happens when the
                            * chain height could not be read. It is NOT zero: a day with
                            * no trades and a day we could not measure look identical on
                            * a card, and only one of them is a quiet market.
                            */
                          if (e.volume24h === null) return 'not measured';
                          /*
                            * "at least" when the page of trades read is full and its
                            * oldest entry is still inside the window, because there may
                            * be more beyond it and the sum is then a floor. Printing it
                            * bare would understate a busy launch and read as exact.
                            */
                          return `${e.volumePartial ? 'at least ' : ''}${compact(e.volume24h, r.quoteDecimals, 2)} ${denomLabel(r.quoteDenom)}`;
                        })()}
                      </span>
                    </div>
                    {activity[r.curveAddress].series.length >= 2 && (
                      <div className="metric-row">
                        <span className="k">Recent fills</span>
                        <span className="card-spark">
                          <Sparkline series={activity[r.curveAddress].series} />
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
