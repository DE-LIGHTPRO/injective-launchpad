'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { CREATOR_FEE_SHARE_BPS, PLATFORM_FEE_SHARE_BPS } from '@/lib/launchLimits';
import { useConnectedAccount } from '@/lib/walletStore';
import type { Quote } from '@/lib/chain';

/**
 * What this launch has earned, and the button that pays it out.
 *
 * WHY IT DID NOT EXIST. `creator_owed` and `platform_owed` have accrued on every trade
 * since the first contract was written, `ClaimFees` has been in the curve's `ExecuteMsg`
 * the whole time, and a grep for any of those names across the whole app returned
 * nothing. The earning was real, the claim was real, and no screen mentioned either: a
 * creator had no way to know they had earned anything and no way to take it. The
 * registration-is-not-wiring failure, applied to the feature that is supposed to be the
 * reason to launch here.
 *
 * SHOWN TO EVERYONE, not only to the creator. Two reasons. The split is a published
 * property of the launch rather than a private arrangement, so a buyer deciding whether
 * to trade can see exactly who is paid out of the fee they are about to pay. And the
 * claim is permissionless on chain: `exec_claim_fees` checks no sender and sends each
 * side to the address stored at launch, so anyone can trigger the payout and nobody can
 * redirect it. A creator does not depend on us to be paid, and we do not depend on them.
 */
export function FeeEarnings({
  curve,
  creator,
  creatorOwed,
  platformOwed,
  creatorPaid,
  platformPaid,
  feeBps,
  quote,
}: {
  curve: string;
  creator: string;
  creatorOwed: bigint;
  platformOwed: bigint;
  /** Lifetime totals already paid out. Zero on a curve too old to have counted. */
  creatorPaid: bigint;
  platformPaid: bigint;
  feeBps: bigint;
  /**
   * THIS launch's quote, not the network's. Every figure in this panel is money the
   * curve holds, and it holds whatever the launch is priced in: rendering a
   * 6-decimal balance scaled as 18 and labelled INJ is not an approximation, it is a
   * different number wearing the wrong name.
   */
  quote: Quote;
}) {
  // The connected account comes from the shared store, so connecting in the header is
  // recognised here too. Local state used to leave this panel asking to connect again.
  const account = useConnectedAccount();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = creatorOwed + platformOwed;
  const nothingToClaim = total === 0n;
  const paid = creatorPaid + platformPaid;
  const isCreator = account !== null && account.address === creator;

  async function claim() {
    if (!account) return;
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const { broadcastExecute, GAS } = await import('@/lib/broadcast');
      const { txHash } = await broadcastExecute({
        contract: curve,
        msg: { claim_fees: {} },
        sender: account.address,
        wallet: account.provider,
        gas: GAS.claim,
      });
      setTxHash(txHash);
      /*
       * THE FIGURES ABOVE ARE SERVER-RENDERED PROPS AND NOTHING REFETCHED THEM.
       *
       * A creator clicked this, the claim landed, and the panel kept showing the
       * same unclaimed balance, so it looked like nothing happened. They clicked
       * again, the contract answered "nothing to claim", and the UI translated that
       * into "The chain refused the transaction" over figures that still said money
       * was owed. Three separate things telling them the opposite of the truth.
       *
       * `router.refresh()` re-runs the server component against the chain, which is
       * the only honest source for these: an optimistic zero here would be a number
       * we invented, and the one thing this panel must not do is show a balance
       * nothing measured.
       */
      router.refresh();
    } catch (e) {
      /*
       * The wallet's own sentence, through the translator the launch path uses. An
       * untranslated chain error here would read as the claim being impossible when
       * the usual cause is a closed prompt.
       */
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 'var(--space-4)' }}>
      <h2>Fees earned</h2>
      {/*
        * "Every trade pays {feeBps}%" was the sentence here, and it is the launch's
        * BASE rate: a buy inside an opening-fee window pays more, and the amount above
        * the base rate is added to `lp_bonus` rather than split, so it never reaches
        * either figure below. Naming the rate the split applies to keeps this panel
        * true in both windows without plumbing the rules in to say so; the quote on
        * the trade panel is where the fee in force is shown.
        */}
      <p className="note">
        This launch&rsquo;s own fee is {Number(feeBps) / 100}% in {quote.label}, and{' '}
        {CREATOR_FEE_SHARE_BPS / 100}% of it is the creator&rsquo;s while{' '}
        {PLATFORM_FEE_SHARE_BPS / 100}% runs this launchpad. The split was set when the
        launch was created and cannot be changed.
      </p>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <div className="metric-row">
          <span className="k">Creator&rsquo;s share, unclaimed</span>
          <span className="v mono">
            {fmt(creatorOwed, quote.decimals, 6)} {quote.label}
          </span>
        </div>
        <div className="metric-row">
          <span className="k">Launchpad&rsquo;s share, unclaimed</span>
          <span className="v mono">
            {fmt(platformOwed, quote.decimals, 6)} {quote.label}
          </span>
        </div>
        {/*
          * The total is here because it is the figure that tells a reader how much
          * the curve is holding beyond its reserve, and the two rows above are what
          * tell them whose it is. Rule: never a total WITHOUT the itemisation.
          */}
        <div className="metric-row">
          <span className="k">Held by the curve, owed out</span>
          <span className="v mono">
            {fmt(total, quote.decimals, 6)} {quote.label}
          </span>
        </div>
      </div>

      {paid > 0n && (
        /*
          * Lifetime, beside the unclaimed figure, because the two answer different
          * questions and the panel used to answer only the first. After a claim
          * `creator_owed` is zero, and the empty state said "Nothing has accrued yet.
          * Fees appear here after the first trade" on a launch that had traded and
          * paid out: measured on the live testnet launch, 0.007 INJ to the creator
          * and 0.003 to the launchpad, with the page insisting nothing had happened.
          */
        <div className="metric-row" style={{ marginTop: 'var(--space-3)' }}>
          <span className="k">Paid out so far, lifetime</span>
          <span className="v mono">
            {fmt(paid, quote.decimals, 6)} {quote.label}
          </span>
        </div>
      )}

      {nothingToClaim ? (
        <p className="note" style={{ marginTop: 'var(--space-4)' }}>
          {paid > 0n
            ? `Everything earned so far has been paid out. New fees appear here as trades happen.`
            : 'Nothing has accrued yet. Fees appear here after the first trade.'}
        </p>
      ) : account === null ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          {/* Sticky header already offers this; a second identical button here is
              the same control twice on one screen. */}
          {/*
              THE APP CANNOT SEE THE KEEPER, so it must not promise it. This read
              "These are paid out automatically. Connect a wallet to send them now
              instead of waiting", on every launch page, to everybody. Meanwhile the
              scheduled sweep had failed on all 20 of its runs since 12 Oct 2026
              because KEEPER_MNEMONIC was never set, so nothing had ever been paid
              automatically and the word "waiting" named a wait with no end.
              Automatic payouts are an operator's cron and a funded wallet, neither
              of which this component can check, so stating it is the same defect as
              a health endpoint reporting a status it never probed.
              And the measured cadence is not a schedule to lean on either: a
              fifteen-minute cron produced 19 runs in 84 hours, a median of 4.6
              hours apart.
              What is always true is the contract property, which is also the part
              that reassures, so that is what it says.
            */}
          <p className="note">
            Anyone can send these to the creator and the launchpad, and sending only
            costs the sender gas. Connect a wallet to do it now.
          </p>
          <p className="note">
            {/*
                THE SAFETY PROPERTY LEADS, because the old wording did not and read
                as a warning. "Anyone can trigger the payout" is alarming on its own
                and reassuring the moment you know it cannot be redirected: the
                contract pays the two addresses fixed when the launch was created,
                and whoever sends the message chooses nothing but to pay the gas.
                That is also what lets payouts be automatic at all, since the keeper
                is an ordinary wallet with no special standing.
              */}
            The payout always goes to the creator and the launchpad at the addresses
            set when this launch was created. Nobody can change where it goes, which
            is why anyone is allowed to trigger it and why sending it only costs the
            sender gas.
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <button className="go" onClick={claim} disabled={busy}>
            {busy ? 'Waiting for your wallet…' : 'Pay out fees'}
          </button>
          <p className="note">
            {isCreator
              ? `This sends your ${fmt(creatorOwed, quote.decimals, 6)} ${quote.label} to this wallet, and the launchpad's share to the launchpad.`
              : 'This pays the creator and the launchpad, not you. You are paying the gas for it.'}
          </p>
        </div>
      )}

      {txHash && (
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Paid out.{' '}
          <a href={`${NETWORK.explorer}/transaction/${txHash}`} target="_blank" rel="noreferrer">
            View the transaction
          </a>
          . The figures above update when the page next reads the chain.
        </p>
      )}
      {error && (
        <p className="note err-text" style={{ marginTop: 'var(--space-3)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
