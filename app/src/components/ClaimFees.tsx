'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { listLaunches, getLaunchDetail, resolveQuote, symbolOf, type Quote } from '@/lib/chain';
import { useConnectedAccount } from '@/lib/walletStore';
import { fmt } from '@/lib/curve';

/**
 * Every fee this wallet can claim, in one place and one transaction.
 *
 * WHY A PAGE AND NOT A BUTTON PER LAUNCH. Claiming already worked, on each launch's
 * own page: a creator with five launches had five balances behind five pages and no
 * way to see the total. The claim is the whole reason to launch here, and it was the
 * least discoverable thing in the product.
 *
 * ONE TRANSACTION, not a loop. Cosmos carries many messages in a single transaction,
 * so a sweep is one wallet prompt, one fee and one atomic result: either every claim
 * lands or none does. Claiming in a loop leaves a creator guessing which of their
 * launches paid out, discoverable only by checking each one.
 *
 * THE PLATFORM'S SHARE RIDES ALONG, and the copy says so rather than hiding it.
 * `exec_claim_fees` checks no sender and pays BOTH sides to the addresses stored at
 * launch, so a creator's claim also settles the launchpad's 30% to the launchpad. It
 * cannot be redirected and the creator is not paying it out of their share: it is
 * the same fee, split at the time of the trade.
 */

interface Claimable {
  id: number;
  curve: string;
  symbol: string;
  owed: bigint;
  quote: Quote;
}

export function ClaimFees() {
  const account = useConnectedAccount();
  const [rows, setRows] = useState<Claimable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    if (!account) {
      setRows(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const launches = await listLaunches();
        /*
         * Only this wallet's launches are read in full. Reading every launch on the
         * board to find a handful would be N round trips for a page about one
         * creator, and the registry already names the creator.
         */
        const mine = launches.filter((l) => l.creator === account.address);
        const detailed = await Promise.all(
          mine.map(async (l) => {
            const d = await getLaunchDetail(l.curve);
            return {
              id: l.id,
              curve: l.curve,
              symbol: symbolOf(l.denom),
              owed: d.creatorOwed,
              quote: await resolveQuote(d.quoteDenom),
            };
          }),
        );
        if (live) setRows(detailed);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [account]);

  const withFees = useMemo(() => (rows ?? []).filter((r) => r.owed > 0n), [rows]);

  async function claimAll() {
    if (!account || withFees.length === 0) return;
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const { broadcastExecuteMany } = await import('@/lib/broadcast');
      const { txHash } = await broadcastExecuteMany({
        calls: withFees.map((r) => ({ contract: r.curve, msg: { claim_fees: {} } })),
        sender: account.address,
        wallet: account.provider,
      });
      setTxHash(txHash);
      // Zeroed locally so the page reflects the claim without a refetch. The chain is
      // the authority; this is the optimistic half and it is only ever zero, never a
      // figure we invented.
      setRows((prev) => (prev ?? []).map((r) => ({ ...r, owed: 0n })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <div className="empty">
        <p>
          Connect a wallet, using the button in the header, to see the fees your
          launches have earned.
        </p>
      </div>
    );
  }

  if (error) return <p className="note danger-text">{error}</p>;
  if (rows === null) return <p className="note">Reading your launches…</p>;

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>This wallet has not created a launch yet.</p>
        <p className="note">
          Every trade on a launch you create pays you 70% of its fee, claimable here at
          any time.
        </p>
      </div>
    );
  }

  return (
    <>
      {withFees.length === 0 ? (
        <p className="note">
          Nothing to claim right now. Fees appear here as your launches are traded.
        </p>
      ) : (
        <>
          <div className="claim-rows">
            {withFees.map((r) => (
              <div className="metric-row" key={r.id}>
                <span className="k">
                  <Link href={`/launch/${r.id}`}>{r.symbol}</Link>
                </span>
                <span className="v mono">
                  {fmt(r.owed, r.quote.decimals, 6)} {r.quote.label}
                </span>
              </div>
            ))}
          </div>

          <button className="go" onClick={claimAll} disabled={busy}>
            {busy
              ? 'Waiting for your wallet…'
              : `Claim from ${withFees.length} ${withFees.length === 1 ? 'launch' : 'launches'}`}
          </button>

          <p className="note">
            {/*
                Stated, not hidden. The same call settles the launchpad's 30% to the
                launchpad, because the contract pays both sides to the addresses
                stored at launch. It is not taken out of your share: it is the same
                fee, split when the trade happened.
              */}
            One transaction, one signature. It also settles the launchpad&rsquo;s 30%
            share of the same fees, which is not deducted from yours.
          </p>
        </>
      )}

      {/*
          Launches with nothing owed are listed too, greyed. Omitting them would make
          a creator wonder whether a launch was missed or simply had no fees, and the
          two look identical when the row is absent.
        */}
      {rows.some((r) => r.owed === 0n) && (
        <p className="note" style={{ marginTop: 'var(--space-4)' }}>
          {rows.filter((r) => r.owed === 0n).map((r) => r.symbol).join(', ')}:{' '}
          nothing owed yet.
        </p>
      )}

      {txHash && (
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Claimed. The chain is the record; this page will show the new balances on its
          next read.
        </p>
      )}
    </>
  );
}
