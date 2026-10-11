'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useConnectedAccount } from '@/lib/walletStore';
import { allBalances } from '@/lib/wallet';
import { symbolOf } from '@/lib/chain';
import { fmt } from '@/lib/curve';
import { TokenLogo } from './TokenLogo';
import type { LaunchRow } from '@/lib/launchList';

const ONE = 10n ** 18n;
/** The factory's fixed supply: 1B tokens at 18 decimals. Market cap is spot * this. */
const TOTAL_SUPPLY = 1_000_000_000n * ONE;

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
      const value = (balance * BigInt(row.marketCap)) / TOTAL_SUPPLY;
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
        label: h.row.quoteLabel ?? h.row.quoteDenom,
        decimals: h.row.quoteDecimals,
        total: 0n,
      };
      cur.total += h.value;
      byQuote.set(key, cur);
    }
    return [...byQuote.values()].filter((t) => t.total > 0n);
  }, [holdings]);

  if (!account) {
    return (
      <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
        {/* The header's connect button is sticky and always in view; a second one
            here would be the same control twice on one screen. */}
        <p>Connect a wallet, using the button in the header, to see what it holds
          across launches.</p>
      </div>
    );
  }

  if (balances === undefined) {
    return (
      <p className="note" style={{ marginTop: 'var(--space-4)' }}>
        Reading {account.label}&rsquo;s balances&hellip;
      </p>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
        <p>
          {failed
            ? 'Balances could not be read just now. Try again in a moment.'
            : 'This wallet holds no launch tokens yet.'}
        </p>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Link href="/" className="go ghost">Browse launches</Link>
        </div>
      </div>
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

      <div className="table-wrap">
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
                      <Link href={`/launch/${h.row.id}`} className="row-link">
                        {symbolOf(h.row.denom)}
                      </Link>
                      <span className="tok-sub">{h.row.graduated ? 'Graduated' : 'On the curve'}</span>
                    </div>
                  </div>
                </td>
                <td className="num mono">{fmt(h.balance, 18, 2)}</td>
                <td className="num mono">
                  {fmt(h.value, h.row.quoteDecimals, 4)} {h.row.quoteLabel ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
