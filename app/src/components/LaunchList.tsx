'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { symbolOf, short } from '@/lib/chain';
import { TokenLogo } from './TokenLogo';
import { StatusChip } from './StatusChip';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { selectLaunches, type LaunchRow, type SortKey } from '@/lib/launchList';

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
  { key: 'progress', label: 'Closest to graduating', hint: 'Highest share of the target raised' },
  { key: 'raised', label: 'Most raised', hint: `Largest amount of ${NETWORK.quoteSymbol} collected` },
  { key: 'newest', label: 'Newest', hint: 'Most recently created' },
];

export function LaunchList({ rows }: { rows: LaunchRow[] }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('progress');
  const [hideGraduated, setHideGraduated] = useState(false);

  // One implementation, in `lib/launchList.ts`, where the tests can reach it.
  const shown = useMemo(
    () => selectLaunches(rows, { q, sort, hideGraduated }),
    [rows, q, sort, hideGraduated],
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
                  <div className="sym" title={r.denom}>
                    {symbolOf(r.denom)}
                  </div>
                </div>
                {/*
                    Status comes from `launchStatus`, never from `graduated` alone.
                    This chip read "live" on a launch whose start time had not arrived,
                    which is the most confident possible label on the one state where
                    the contract refuses every buy.
                  */}
                <StatusChip graduated={r.graduated} rules={r.rules} />
              </div>

              <div className="bar">
                <i style={{ width: `${Math.min(100, r.progress * 100).toFixed(1)}%` }} />
              </div>

              <div style={{ marginTop: 'var(--space-4)' }}>
                <div className="metric-row">
                  <span className="k">Raised</span>
                  <span className="v mono">
                    {fmt(BigInt(r.raised), 18, 2)} / {fmt(BigInt(r.target), 18, 0)}{' '}
                    {NETWORK.quoteSymbol}
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
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
