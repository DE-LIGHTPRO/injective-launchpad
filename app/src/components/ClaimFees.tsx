'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  listLaunches,
  listQuotes,
  getLaunchDetail,
  quoteFromList,
  symbolOf,
  mapWithConcurrency,
  DETAIL_CONCURRENCY,
  type Quote,
} from '@/lib/chain';
import { useConnectedAccount } from '@/lib/walletStore';
import { TxDialog, useTxFlow } from './TxDialog';
import { fmt } from '@/lib/curve';
import { selectClaimable, type ClaimRow } from '@/lib/claimable';
import { launchPath } from '@/lib/launchPath';
import { CREATOR_FEE_SHARE_BPS, PLATFORM_FEE_SHARE_BPS } from '@/lib/launchLimits';
import { EmptyState } from './EmptyState';
import { MarkFees } from './EmptyMark';

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

/*
 * Extends `ClaimRow` so the tested selector can filter it and hand it back WITH the
 * resolved quote. `creator` and `quoteDenom` are what the selector needs; `quote` is
 * what rendering needs, and keeping them on one row is why the selector is generic.
 */
interface Claimable extends ClaimRow {
  quote: Quote;
  /** The launch's canonical URL, resolved against the whole board. */
  path: string;
}

export function ClaimFees() {
  const account = useConnectedAccount();
  const [rows, setRows] = useState<Claimable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tx = useTxFlow();

  useEffect(() => {
    if (!account) {
      setRows(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        /*
         * The allowlist is read ONCE, here, and picked from per launch below.
         *
         * It used to be `await resolveQuote(d.quoteDenom)` inside the fan-out, and
         * `resolveQuote` is `listQuotes()` plus a local find - so a creator with ten
         * launches sent ten byte-identical `quotes {}` queries to the same contract, a
         * third of this page's requests, for a list that is the same for every launch on
         * the board. Nothing cached them: `smartQuery` is a bare `fetch` and this is a
         * client component, so Next's request dedupe never sees it.
         *
         * Read alongside the launches rather than after them, because neither needs the
         * other.
         */
        const [launches, { quotes }] = await Promise.all([listLaunches(), listQuotes()]);
        /*
         * Only this wallet's launches are read in full. Reading every launch on the
         * board to find a handful would be N round trips for a page about one
         * creator, and the registry already names the creator.
         */
        const mine = launches.filter((l) => l.creator === account.address);
        /*
         * BOUNDED, like the board's. Each launch here is `getLaunchDetail`, two smart
         * queries, so a prolific creator fans out two requests per launch at once - see
         * `DETAIL_CONCURRENCY` for what the endpoint does to a burst.
         *
         * STILL ALL-OR-NOTHING, unlike the board's, and that is the right answer here
         * rather than an omission. This page is the input to ONE transaction that claims
         * the launches it lists; a partial list would build a transaction that quietly
         * leaves money behind, and the creator's only signal would be a total they had no
         * reason to doubt. A board that is short a row costs a reader a reload. A claim
         * that is short a message costs them the claim.
         */
        const detailed = await mapWithConcurrency(mine, DETAIL_CONCURRENCY, async (l) => {
          const d = await getLaunchDetail(l.curve);
          return {
            id: l.id,
            curve: l.curve,
            symbol: symbolOf(l.denom),
            // Resolved against every launch, not just this creator's: a ticker
            // clash with somebody else's launch is exactly the case the short
            // slug cannot serve.
            path: launchPath(l, launches),
            creator: d.creator,
            owed: d.creatorOwed,
            quoteDenom: d.quoteDenom,
            quote: quoteFromList(d.quoteDenom, quotes),
          };
        });
        if (live) setRows(detailed);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [account]);

  /*
   * The selection lives in `lib/claimable.ts`, where tests can reach it. It decides
   * whose money is shown, and an inline filter is one no test can exercise.
   */
  const { withFees } = useMemo(
    () => selectClaimable(rows ?? [], account?.address ?? null),
    [rows, account],
  );

  async function claimAll() {
    if (!account || withFees.length === 0) return;
    setBusy(true);
    try {
      const { broadcastExecuteMany } = await import('@/lib/broadcast');
      const confirmed = await tx.run({
        title: withFees.length === 1 ? `Claim fees from ${withFees[0].symbol}` : `Claim fees from ${withFees.length} launches`,
        send: (onStage) =>
          broadcastExecuteMany({
            calls: withFees.map((r) => ({ contract: r.curve, msg: { claim_fees: {} } })),
            sender: account.address,
            wallet: account.provider,
            onStage,
          }),
      });
      /*
       * ZEROED ONLY ON A CONFIRMATION, which is the difference between an optimistic
       * figure and an invented one.
       *
       * This ran on any hash. A batch refused in the block - the commonest reason
       * being a second tab having claimed the same fees already - still zeroed every
       * row, so the page showed a creator that their money had moved on the strength
       * of a transaction the chain threw out. The zero was never the problem; acting
       * on "sent" rather than on "landed" was.
       */
      if (confirmed) {
        // The chain is the authority; this is the optimistic half and it is only ever
        // zero, never a figure we invented.
        setRows((prev) => (prev ?? []).map((r) => ({ ...r, owed: 0n })));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <EmptyState mark={<MarkFees />} title="No fees to claim yet">
        {/*
            The share is NOT restated here. `fee-ceiling-claims.test.ts` caught the
            first version saying "70% of every trading fee", which is wrong: the share
            applies to a launch's own fee rate, not to the opening premium, so "every"
            overstates what a creator is owed. The page's subtitle two lines above
            already states it correctly, and a second copy is one more place for the
            two to disagree.
          */}
        Connect a wallet, using the button in the header, to see the fees your
        launches have earned.
      </EmptyState>
    );
  }

  if (error) return <p className="note danger-text">{error}</p>;
  if (rows === null) return <p className="note">Reading your launches…</p>;

  if (rows.length === 0) {
    /*
     * THE BRANCH A REAL CREATOR ACTUALLY LANDS ON. The disconnected state above got the
     * treatment first and this one was left bare, which is the wrong way round: nobody
     * with a wallet connected ever sees the other one. Fixing the instance in front of
     * me rather than the class is what left it behind.
     */
    return (
      <EmptyState
        mark={<MarkFees />}
        title="This wallet has not created a launch yet"
        action={
          <Link href="/create" className="go">
            Create a launch
          </Link>
        }
      >
        Every trade on a launch you create pays you {CREATOR_FEE_SHARE_BPS / 100}% of
        the launch&rsquo;s own fee, claimable here at any time.
      </EmptyState>
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
                  <Link href={r.path}>{r.symbol}</Link>
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
            One transaction, one signature. It also settles the launchpad&rsquo;s{' '}
            {PLATFORM_FEE_SHARE_BPS / 100}% share of the same fees, which is not
            deducted from yours.
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

      <TxDialog flow={tx} />
    </>
  );
}
