'use client';

import { useState } from 'react';
import { ConnectWallet } from './ConnectWallet';
import { fmt } from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { CREATOR_FEE_SHARE_BPS, PLATFORM_FEE_SHARE_BPS } from '@/lib/launchLimits';
import type { WalletAccount } from '@/lib/wallet';

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
}: {
  curve: string;
  creator: string;
  creatorOwed: bigint;
  platformOwed: bigint;
  /** Lifetime totals already paid out. Zero on a curve too old to have counted. */
  creatorPaid: bigint;
  platformPaid: bigint;
  feeBps: bigint;
}) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
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
      <p className="note">
        Every trade pays {Number(feeBps) / 100}% in {NETWORK.quoteSymbol}.{' '}
        {CREATOR_FEE_SHARE_BPS / 100}% of that fee is the creator&rsquo;s and{' '}
        {PLATFORM_FEE_SHARE_BPS / 100}% runs this launchpad. The split was set when the
        launch was created and cannot be changed.
      </p>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <div className="metric-row">
          <span className="k">Creator&rsquo;s share, unclaimed</span>
          <span className="v mono">
            {fmt(creatorOwed, 18, 6)} {NETWORK.quoteSymbol}
          </span>
        </div>
        <div className="metric-row">
          <span className="k">Launchpad&rsquo;s share, unclaimed</span>
          <span className="v mono">
            {fmt(platformOwed, 18, 6)} {NETWORK.quoteSymbol}
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
            {fmt(total, 18, 6)} {NETWORK.quoteSymbol}
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
            {fmt(paid, 18, 6)} {NETWORK.quoteSymbol}
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
          <ConnectWallet onAccount={setAccount} />
          <p className="note">
            Anyone can trigger the payout, and it pays the creator and the launchpad at
            the addresses set when this launch was created. Connecting only pays the gas.
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <button className="go" onClick={claim} disabled={busy}>
            {busy ? 'Waiting for your wallet…' : 'Pay out fees'}
          </button>
          <p className="note">
            {isCreator
              ? `This sends your ${fmt(creatorOwed, 18, 6)} ${NETWORK.quoteSymbol} to this wallet, and the launchpad's share to the launchpad.`
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
