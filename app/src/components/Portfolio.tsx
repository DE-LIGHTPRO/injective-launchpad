'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useConnectedAccount } from '@/lib/walletStore';
import { allBalances, shortAddress } from '@/lib/wallet';
import { symbolOf } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { FIXED_TOTAL_SUPPLY } from '@/lib/launchLimits';
import { TokenLogo } from './TokenLogo';
import { rowQuoteLabel, type LaunchRow } from '@/lib/launchList';
import { EmptyState } from './EmptyState';
import { MarkHoldings } from './EmptyMark';

/*
 * The divisor is `FIXED_TOTAL_SUPPLY`, not a local copy of it.
 *
 * This file and `LaunchList` each declared `1_000_000_000n * ONE` while
 * `launchLimits.ts` held the same figure mirroring the contract. Three copies of a
 * number that divides every valuation on two screens: if the factory's supply ever
 * changed, the board would keep pricing against the old one and every holding here
 * would be wrong by the ratio, with nothing on either screen looking unusual. That
 * is the same shape as the two fee caps, and the fix is the same - one declaration.
 */

interface Holding {
  row: LaunchRow;
  balance: bigint;
  /** Value in the launch's quote, base units: balance * spot, and spot = marketCap / supply. */
  value: bigint;
}

/**
 * What the connected wallet holds across every launch, valued in each launch's own quote.
 *
 * The value is derived from the board's own `marketCap` (spot price times the fixed
 * supply), so a holding is valued at exactly the price the board shows and the two can
 * never disagree. Balances come from ONE bank query, cross-referenced against the
 * launches; a token the wallet holds that is not a launch here is simply not shown.
 *
 * Totals are per quote, never summed across them: 18-decimal INJ added to 6-decimal USDC
 * would be wrong by orders of magnitude, and there is no oracle here to convert with.
 */
export function Portfolio({ rows }: { rows: LaunchRow[] }) {
  const account = useConnectedAccount();
  const [balances, setBalances] = useState<Record<string, bigint> | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!account) {
      setBalances(undefined);
      setFailed(false);
      return;
    }
    let live = true;
    setBalances(undefined);
    setFailed(false);
    void allBalances(account.address).then((b) => {
      if (!live) return;
      if (b === null) setFailed(true);
      setBalances(b ?? {});
    });
    return () => {
      live = false;
    };
  }, [account]);

  const holdings = useMemo<Holding[]>(() => {
    if (!balances) return [];
    const out: Holding[] = [];
    for (const row of rows) {
      const balance = balances[row.denom] ?? 0n;
      if (balance <= 0n) continue;
      const value = (balance * BigInt(row.marketCap)) / FIXED_TOTAL_SUPPLY;
      out.push({ row, balance, value });
    }
    // Most valuable first, within a quote; different quotes just interleave by value,
    // which is fine because each row carries and shows its own ticker.
    return out.sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  }, [balances, rows]);

  const totals = useMemo(() => {
    const byQuote = new Map<string, { label: string; decimals: number; total: bigint }>();
    for (const h of holdings) {
      const key = h.row.quoteDenom;
      const cur = byQuote.get(key) ?? {
        label: rowQuoteLabel(h.row),
        decimals: h.row.quoteDecimals,
        total: 0n,
      };
      cur.total += h.value;
      byQuote.set(key, cur);
    }
    return [...byQuote.values()].filter((t) => t.total > 0n);
  }, [holdings]);

  if (!account) {
    /*
     * No action here on purpose. The header's connect button is sticky and always in
     * view, so a second one would be the same control twice on one screen, and
     * `EmptyState` makes the action optional for exactly that reason.
     */
    return (
      <EmptyState mark={<MarkHoldings />} title="No holdings to show">
        Connect a wallet, using the button in the header, to see what it holds
        across launches.
      </EmptyState>
    );
  }

  if (balances === undefined) {
    return (
      <p className="note" style={{ marginTop: 'var(--space-4)' }}>
        Reading {shortAddress(account.address)}&rsquo;s balances&hellip;
      </p>
    );
  }

  if (holdings.length === 0) {
    /*
     * A FAILED READ IS NOT AN EMPTY WALLET, which is why the title changes with it.
     * Showing "No launch tokens yet" over balances that could not be read states
     * something nobody measured, and it is the direction that matters: a holder told
     * they hold nothing has been given a wrong answer, not a missing one.
     */
    return (
      <EmptyState
        mark={<MarkHoldings />}
        title={failed ? 'Balances could not be read' : 'No launch tokens yet'}
        action={
          failed ? null : (
            <Link href="/" className="go ghost">
              Browse launches
            </Link>
          )
        }
      >
        {failed
          ? 'The network did not answer just now, so this is not a statement about what the wallet holds. Try again in a moment.'
          : 'Tokens bought from any launch on this board will appear here.'}
      </EmptyState>
    );
  }

  return (
    <>
      {totals.length > 0 && (
        <div className="totals">
          {totals.map((t) => (
            <div key={t.label}>
              <span className="v mono">
                {fmt(t.total, t.decimals, 4)} {t.label}
              </span>
              <span className="k">Holdings value</span>
            </div>
          ))}
        </div>
      )}

      {/* Focusable for the same reason as the launch board: a scroll container with no
          tab stop fails WCAG 2.1.1. See the longer note in LaunchList. */}
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Your holdings">
        <table className="board">
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className="num">Balance</th>
              <th scope="col" className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.row.denom}>
                <td>
                  <div className="tok">
                    <TokenLogo profile={h.row.profile} symbol={symbolOf(h.row.denom)} size={32} />
                    <div className="tok-text">
                      <Link href={h.row.path} className="row-link">
                        {symbolOf(h.row.denom)}
                      </Link>
                      <span className="tok-sub">{h.row.graduated ? 'Graduated' : 'On the curve'}</span>
                    </div>
                  </div>
                </td>
                <td className="num mono">{fmt(h.balance, 18, 2)}</td>
                <td className="num mono">
                  {/*
                    The ticker is not optional here, and the sort above is why:
                    quotes interleave, so an 18-decimal INJ value sits directly
                    above a 6-decimal USDC one. This used to print `?? ''`.
                  */}
                  {fmt(h.value, h.row.quoteDecimals, 4)} {rowQuoteLabel(h.row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
